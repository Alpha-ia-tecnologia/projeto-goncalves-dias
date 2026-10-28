import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, Gesture } from "../contracts";
import {
  ARCHIVE_TOOL_DESCRIPTION, ArchiveToolInput, describeReplyFailure, MAX_AGENT_MODEL_CALLS, MAX_AGENT_TOOL_CALLS,
  MAX_RESEARCH_CALLS, PoetAgentError, PoetReplySchema, RESEARCH_LIMIT_RESULT, RESEARCH_QUERY_DESCRIPTION,
  RESEARCH_TOOL_DESCRIPTION, ResearchToolInput, type PoetResearch,
} from "./poet-agent";
import { GONCALVES_DIAS_PROMPT, lookupPoetKnowledge, POET_KNOWLEDGE_TOPICS } from "./poet-persona";
import { RESEARCH_SOURCES } from "./poet-research";

export const CLAUDE_DEFAULT_MODEL = "claude-opus-5-5";

// The final turn is held to this envelope by the API. First person and length are
// still checked by PoetReplySchema afterwards: the API's JSON schemas carry no
// patterns or string lengths.
const REPLY_FORMAT: Anthropic.Beta.BetaJSONOutputFormat = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Minha resposta falada, em português e em primeira pessoa, sem rubricas de gestos nem Markdown." },
      gesture: { type: "string", enum: ["wave", "nod", "none"], description: "wave para saudar/acenar, nod para concordar, none nos demais casos." },
    },
    required: ["text", "gesture"],
    additionalProperties: false,
  },
};

const SYSTEM = GONCALVES_DIAS_PROMPT + "\nSua resposta final é o objeto JSON com text e gesture. A fala em text deve conter uma marca clara de primeira pessoa: eu, meu, minha, nossa, comigo ou verbos como sou, escrevi, penso e acho.";
const REPAIR_INSTRUCTION = "Corrija a resposta final: devolva apenas o JSON com text (1 a 1600 caracteres, em primeira pessoa como Gonçalves Dias, com eu/meu/minha/nossa/sou/nasci/escrevi/penso) e gesture (wave, nod ou none). Não narre a vida de Gonçalves Dias em terceira pessoa.";

// Lengths are left to ResearchToolInput: strict tool schemas carry no string lengths either.
const ARCHIVE_TOOL: Anthropic.Beta.BetaTool = {
  name: "consultar_acervo",
  description: ARCHIVE_TOOL_DESCRIPTION,
  strict: true,
  input_schema: { type: "object", properties: { topic: { type: "string", enum: [...POET_KNOWLEDGE_TOPICS] } }, required: ["topic"], additionalProperties: false },
};
const RESEARCH_TOOL: Anthropic.Beta.BetaTool = {
  name: "pesquisar",
  description: RESEARCH_TOOL_DESCRIPTION,
  strict: true,
  input_schema: {
    type: "object",
    properties: { source: { type: "string", enum: [...RESEARCH_SOURCES] }, query: { type: "string", description: RESEARCH_QUERY_DESCRIPTION } },
    required: ["source", "query"],
    additionalProperties: false,
  },
};

export type ClaudePoetInput = {
  apiKey: string;
  model: string;
  message: string;
  history: ChatMessage[];
  signal: AbortSignal;
  fetch?: typeof fetch;
  /** Offered to the model as pesquisar only when the server supplies it. */
  research?: PoetResearch;
};

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

export async function runClaudePoet(input: ClaudePoetInput): Promise<{ text: string; gesture: Gesture }> {
  input.signal.throwIfAborted();
  // The caller's transport already bounds the deadline and the response size; a
  // failure falls back to DeepSeek instead of being retried here.
  const client = new Anthropic({ apiKey: input.apiKey, fetch: input.fetch, maxRetries: 0 });
  const research = input.research;
  const tools = research ? [ARCHIVE_TOOL, RESEARCH_TOOL] : [ARCHIVE_TOOL];
  // Request-local and append-only: every assistant turn goes back exactly as it came.
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...input.history.map((message): Anthropic.Beta.BetaMessageParam => ({ role: message.role, content: message.content })),
    { role: "user", content: input.message },
  ];
  let toolCalls = 0;
  let researchCalls = 0;
  let repaired = false;

  const runTool = async (use: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
    const result = (content: string, isError = false): Anthropic.Beta.BetaToolResultBlockParam =>
      ({ type: "tool_result", tool_use_id: use.id, content, ...(isError ? { is_error: true } : {}) });
    if (use.name === "consultar_acervo") {
      const parsed = ArchiveToolInput.safeParse(use.input);
      return parsed.success ? result(lookupPoetKnowledge(parsed.data.topic)) : result("Tema do acervo inválido.", true);
    }
    if (use.name === "pesquisar" && research) {
      const parsed = ResearchToolInput.safeParse(use.input);
      if (!parsed.success) return result("Pesquisa inválida: informe source (enciclopedia ou poema) e uma consulta de 2 a 200 caracteres.", true);
      if (++researchCalls > MAX_RESEARCH_CALLS) return result(RESEARCH_LIMIT_RESULT);
      try { return result(await research(parsed.data.source, parsed.data.query)); } catch { return result("A pesquisa não pôde ser concluída agora.", true); }
    }
    return result(`A ferramenta ${use.name} não está disponível.`, true);
  };

  for (let call = 0; call < MAX_AGENT_MODEL_CALLS; call++) {
    const response = await client.beta.messages.create({
      model: input.model,
      max_tokens: 16000,
      // A conversation turn, spoken aloud: low effort keeps the reply quick.
      output_config: { effort: "low", format: REPLY_FORMAT },
      // On a safety decline the API retries on the model Anthropic recommends for it.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      system: SYSTEM,
      tools,
      messages,
    }, { signal: input.signal });

    if (response.stop_reason === "refusal") throw new PoetAgentError("REFUSED", response.stop_details?.category ?? "sem categoria");
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason === "tool_use") {
      const uses = response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use");
      toolCalls += uses.length;
      if (toolCalls > MAX_AGENT_TOOL_CALLS) throw new PoetAgentError("AGENT_LIMIT");
      // All results of one turn go back together, in a single user message.
      messages.push({ role: "user", content: await Promise.all(uses.map(runTool)) });
      continue;
    }

    const structured = parseJson(response.content.map(block => block.type === "text" ? block.text : "").join("").trim());
    const reply = PoetReplySchema.safeParse(structured);
    if (reply.success) return { text: reply.data.text.trim(), gesture: reply.data.gesture };
    if (repaired) throw new PoetAgentError("INVALID_RESPONSE", describeReplyFailure(structured, reply.error.issues));
    repaired = true;
    messages.push({ role: "user", content: REPAIR_INSTRUCTION });
  }
  throw new PoetAgentError("AGENT_LIMIT");
}
