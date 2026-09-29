import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ChatDeepSeek } from "@langchain/deepseek";
import { createAgent, createMiddleware, tool, toolStrategy } from "langchain";
import * as z from "zod";
import type { ChatMessage, Gesture } from "../contracts";
import { GONCALVES_DIAS_PROMPT, lookupPoetKnowledge, POET_KNOWLEDGE_TOPICS } from "./poet-persona";

export const MAX_AGENT_MODEL_CALLS = 4;

// JSON Schema retains patterns, whereas arbitrary Zod refinements are lost when
// ToolStrategy converts the schema. This gives the agent actionable retry feedback.
const firstPerson = String.raw`(?:[Ee]u|[Mm]eu[s]?|[Mm]inha[s]?|[Mm]im|[Cc]omigo|[Ss]ou|[Ee]stou|[Ff]ui|[Nn]asci|[Ee]screvi|[Vv]ivi|[Ee]studei|[Pp]ubliquei|[Ss]into|[Cc]reio|[Pp]enso|[Pp]osso|[Qq]uero|[Tt]rago|[Tt]enho|[Cc]onvido|[Aa]gradeço|[Rr]ecebo|[Pp]refiro|[Ll]embro|[Ff]alo|[Dd]esejo|[Aa]prendi|[Dd]igo|[Vv]ejo|[Oo]fereço|[Pp]rocuro|[Ss]ei|[Pp]eço|[Aa]legro-me)`;
const thirdPersonSelf = String.raw`(?:[Gg]onçalves [Dd]ias|[Oo] poeta)\s+(?:foi|é|era|nasceu|escreveu|viveu|estudou|publicou|morreu)\b`;
const firstPersonPattern = new RegExp(String.raw`^(?![\s\S]*${thirdPersonSelf})(?=[\s\S]*(?:^|[^A-Za-zÀ-ÿ])${firstPerson}(?:$|[^A-Za-zÀ-ÿ]))[\s\S]+$`);

export const PoetReplySchema = z.object({
  text: z.string().min(1).max(1600).regex(firstPersonPattern,
    "Fale como Gonçalves Dias, em primeira pessoa. Use eu, meu, minha, comigo ou um verbo como sou, nasci, escrevi.")
    .describe("Minha resposta falada, em português e em primeira pessoa, sem rubricas de gestos nem Markdown."),
  gesture: z.enum(["wave", "nod", "none"]).describe("wave para saudar/acenar, nod para concordar, none nos demais casos."),
}).strict().meta({
  title: "resposta_do_poeta",
  description: "Minha resposta final como Gonçalves Dias, com texto em primeira pessoa e gesto do avatar.",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class PoetAgentError extends Error {
  /**
   * `detail` says which rule the reply broke, for the server log. Without it a
   * failure here reaches the browser as a bare 502 and reaches whoever runs the
   * server as nothing at all: the reply that caused it is gone by then, and the
   * question has to be guessed at from outside.
   */
  constructor(public readonly code: "AGENT_LIMIT" | "INVALID_RESPONSE", public readonly detail?: string) {
    super(code === "AGENT_LIMIT" ? "O agente atingiu o limite de etapas." : "A resposta do agente não respeitou o formato esperado.");
    this.name = "PoetAgentError";
  }
}

/** The text of a message, whether it arrived as a string or as content blocks. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map(block => isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : "")
    .join("")
    .trim();
}

/**
 * The poet's last spoken words, when he answered without calling the tool that
 * was supposed to carry them. Only the envelope is rebuilt: no gesture is
 * invented, and "none" is the honest answer, since the caller already decides
 * for itself when a greeting deserves a wave.
 */
export function recoverStructuredReply(messages: unknown): unknown {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!(message instanceof AIMessage)) continue;
    const text = messageText(message.content);
    if (text) return { text, gesture: "none" };
  }
  return undefined;
}

/**
 * Names what a rejected reply got wrong, briefly enough for a log line. The
 * excerpt is the poet's own answer - what the visitor would have been shown -
 * and never the question that was asked.
 */
export function describeReplyFailure(value: unknown, issues: readonly { code: string; path: PropertyKey[] }[]): string {
  const text = isRecord(value) && typeof value.text === "string" ? value.text : null;
  const parts = issues.map(issue => {
    const field = issue.path.map(String).join(".") || "(raiz)";
    return issue.code === "invalid_format" ? `${field}: não soou em primeira pessoa` : `${field}: ${issue.code}`;
  });
  if (!isRecord(value)) parts.push("o agente não chegou a chamar resposta_do_poeta");
  const size = text === null ? "sem texto" : `${text.length} caracteres`;
  const excerpt = text === null ? "" : ` | começo: ${JSON.stringify(text.slice(0, 120))}`;
  return `${parts.length ? parts.join("; ") : "recusado sem motivo declarado"} | ${size}${excerpt}`;
}

export type PoetAgentInput = {
  apiKey: string;
  model: string;
  message: string;
  history: ChatMessage[];
  signal: AbortSignal;
  fetch?: typeof fetch;
};

export async function runPoetAgent(input: PoetAgentInput): Promise<{ text: string; gesture: Gesture }> {
  input.signal.throwIfAborted();
  const model = new ChatDeepSeek({
    apiKey: input.apiKey,
    model: input.model,
    temperature: 0.6,
    maxTokens: 750,
    maxRetries: 0,
    streaming: false,
    modelKwargs: { thinking: { type: "disabled" } },
    configuration: { fetch: input.fetch, maxRetries: 0 },
  });

  const consultArchive = tool(
    ({ topic }) => lookupPoetKnowledge(topic),
    {
      name: "consultar_acervo",
      description: "Consulte fatos verificados de minha vida, obras, estilo, contexto e da escola EDUCAPRIME, ou o trecho disponível de Canção do exílio. Use antes de afirmar fatos biográficos, dados da escola ou citar meus versos.",
      schema: z.object({ topic: z.enum(POET_KNOWLEDGE_TOPICS) }).strict(),
    },
  );

  let modelCalls = 0;
  let toolCalls = 0;
  // Request-local state: no global checkpointer and no conversation sharing.
  const agent = createAgent({
    model,
    tools: [consultArchive],
    systemPrompt: GONCALVES_DIAS_PROMPT + "\nConclua chamando resposta_do_poeta. Sua fala deve conter uma marca clara de primeira pessoa: eu, meu, minha, comigo ou verbos como sou, escrevi e penso.",
    responseFormat: toolStrategy(PoetReplySchema, {
      handleError: () => "Corrija a resposta final: apenas text (1 a 1600 caracteres, primeira pessoa como Gonçalves Dias, com eu/meu/minha/sou/nasci/escrevi) e gesture (wave, nod ou none). Não narre Gonçalves Dias em terceira pessoa. Chame resposta_do_poeta uma única vez.",
      toolMessageContent: "Resposta do poeta validada.",
    }),
    middleware: [
      createMiddleware({
        name: "PoetExecutionBudget",
        wrapModelCall: async (request, handler) => {
          if (++modelCalls > MAX_AGENT_MODEL_CALLS) throw new PoetAgentError("AGENT_LIMIT");
          return handler(request);
        },
        wrapToolCall: async (request, handler) => {
          if (++toolCalls > 3) throw new PoetAgentError("AGENT_LIMIT");
          return handler(request);
        },
      }),
    ],
  });

  try {
    const result = await agent.invoke(
      { messages: [...input.history.map(message => message.role === "user" ? new HumanMessage(message.content) : new AIMessage(message.content)), new HumanMessage(input.message)] },
      // No maxConcurrency. It used to be 1, and that was the whole of a bug the
      // visitor met as a bare 502: asked to sing, the model would request two
      // archive topics in the same turn - cancao-do-exilio and obras - the graph
      // would fan out into two tasks, only one fitted, and the run ended there
      // with the tool calls never executed, no reply composed and no error
      // raised. It bought nothing either, because the only node that can fan out
      // is consultar_acervo, and that is a lookup in a table held in memory, not
      // a call anyone needs throttled.
      { signal: input.signal, recursionLimit: 24, runName: "goncalves_dias" },
    );
    input.signal.throwIfAborted();
    // The agent does not always put its answer in the envelope. Asked to sing
    // or to recite, it sometimes replies in plain prose and never calls
    // resposta_do_poeta, and the whole reply was being thrown away for the
    // missing wrapper: the visitor saw a 502 where the poet had in fact
    // answered. What is recovered here is only the envelope - the text still
    // has to pass the same rules, first person and length included, and is
    // still refused if it does not.
    const structured = result.structuredResponse ?? recoverStructuredReply(result.messages);
    const reply = PoetReplySchema.safeParse(structured);
    if (!reply.success) {
      throw new PoetAgentError("INVALID_RESPONSE", describeReplyFailure(structured, reply.error.issues));
    }
    return { text: reply.data.text.trim(), gesture: reply.data.gesture };
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
      if (cause instanceof PoetAgentError) throw cause;
      cause = cause.cause;
    }
    if (error instanceof Error && ["ModelCallLimitMiddlewareError", "ToolCallLimitMiddlewareError", "GraphRecursionError"].includes(error.name)) {
      throw new PoetAgentError("AGENT_LIMIT");
    }
    throw error;
  }
}
