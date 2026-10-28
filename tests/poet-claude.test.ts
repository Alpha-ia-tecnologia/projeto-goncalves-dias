import { describe, expect, it, vi } from "vitest";
import { MAX_AGENT_MODEL_CALLS, MAX_RESEARCH_CALLS, PoetAgentError } from "../lib/server/poet-agent";
import { CLAUDE_DEFAULT_MODEL, runClaudePoet, type ClaudePoetStats } from "../lib/server/poet-claude";

type ClaudeBlock = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type ClaudeRequest = {
  model: string;
  system?: unknown;
  messages: { role: string; content: string | ClaudeBlock[] }[];
  tools?: { name: string; strict?: boolean }[];
  output_config?: { effort?: string; format?: { type: string } };
  fallbacks?: unknown;
  thinking?: unknown;
  temperature?: unknown;
};

const message = (content: ClaudeBlock[], stop_reason: string, extra: Record<string, unknown> = {}) => ({
  id: "msg_poet_test", type: "message", role: "assistant", model: CLAUDE_DEFAULT_MODEL, content, stop_reason,
  stop_sequence: null, usage: { input_tokens: 30, output_tokens: 20, cache_read_input_tokens: 4000 }, ...extra,
});
const finalReply = (text: string, gesture = "none") => message([{ type: "text", text: JSON.stringify({ text, gesture }) }], "end_turn");
const toolCall = (name: string, input: unknown, id = "toolu_poet") => message([{ type: "tool_use", id, name, input }], "tool_use");
const greeting = "Eu sou Gonçalves Dias e recebo você com alegria.";

function provider(respond: (request: ClaudeRequest, turn: number) => unknown) {
  const requests: ClaudeRequest[] = [];
  const headers: Headers[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    if (typeof body !== "string") throw new Error("Expected a JSON provider request");
    requests.push(JSON.parse(body) as ClaudeRequest);
    headers.push(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
    return Response.json(respond(requests.at(-1)!, requests.length));
  });
  return { requests, headers, fetcher };
}

type Research = (source: "enciclopedia" | "poema", query: string) => Promise<string>;
const run = (fetcher: typeof fetch, text = "Olá", research?: Research, onStats?: (stats: ClaudePoetStats) => void) => runClaudePoet({
  apiKey: "anthropic-test-only",
  model: CLAUDE_DEFAULT_MODEL,
  message: text,
  history: [{ role: "assistant", content: "Bem-vindo ao meu gabinete." }],
  signal: new AbortController().signal,
  fetch: fetcher,
  research,
  onStats,
});

describe("Gonçalves Dias on Claude", () => {
  it("asks Claude Sonnet 5.5 for the JSON envelope, with low effort and refusal fallbacks", async () => {
    const { fetcher, requests, headers } = provider(() => finalReply(greeting, "wave"));
    expect(await run(fetcher)).toEqual({ text: greeting, gesture: "wave" });
    const [request] = requests;
    expect(request.model).toBe("claude-sonnet-5-5");
    expect(request.output_config).toMatchObject({ effort: "low", format: { type: "json_schema" } });
    expect(request.fallbacks).toBe("default");
    expect(headers[0].get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    // Sonnet 5.5 rejects disabled thinking and sampling parameters.
    expect(request.thinking).toBeUndefined();
    expect(request.temperature).toBeUndefined();
    expect(request.messages.map(entry => entry.role)).toEqual(["assistant", "user"]);
  });

  it("holds the whole collection in its instructions instead of an archive tool", async () => {
    const { fetcher, requests } = provider(() => finalReply("Eu nasci na região de Caxias, no Maranhão, em 1823."));
    await run(fetcher, "Onde você nasceu?");
    const system = JSON.stringify(requests[0].system);
    expect(system).toContain("ACERVO À MÃO");
    expect(system).toMatch(/10 de agosto de 1823/);
    expect(system).toMatch(/Turu/);
    // Without research there is nothing to call: one model call answers.
    expect(requests[0].tools).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("runs a public search and hands the result back in the next turn", async () => {
    const research = vi.fn<Research>(async () => JSON.stringify({ available: true, title: "Machado de Assis" }));
    const answer = "Eu admiro Machado de Assis, que veio depois de mim e escreveu romances que ainda hoje se leem.";
    const { fetcher, requests } = provider((_request, turn) => turn === 1 ? toolCall("pesquisar", { source: "enciclopedia", query: "Machado de Assis" }, "toolu_busca") : finalReply(answer));
    expect(await run(fetcher, "Quem foi Machado de Assis?", research)).toEqual({ text: answer, gesture: "none" });
    expect(requests[0].tools?.map(tool => tool.name)).toEqual(["pesquisar"]);
    expect(requests[0].tools?.every(tool => tool.strict)).toBe(true);
    expect(research).toHaveBeenCalledWith("enciclopedia", "Machado de Assis");
    const results = requests[1].messages.at(-1)!.content as ClaudeBlock[];
    expect(results[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_busca" });
    // The assistant turn goes back exactly as it came, before the results.
    expect(requests[1].messages.at(-2)).toMatchObject({ role: "assistant", content: [{ type: "tool_use", id: "toolu_busca" }] });
  });

  it("caps public research and answers an archive call as unavailable", async () => {
    const research = vi.fn<Research>(async () => JSON.stringify({ available: true, title: "Canção do exílio" }));
    const calls = Array.from({ length: MAX_RESEARCH_CALLS + 1 }, (_, index) => ({ type: "tool_use", id: `toolu_${index}`, name: "pesquisar", input: { source: "poema", query: "Canção do exílio" } }));
    const { fetcher, requests } = provider((_request, turn) => turn === 1
      ? message([...calls, { type: "tool_use", id: "toolu_acervo", name: "consultar_acervo", input: { topic: "vida" } }], "tool_use")
      : finalReply("Eu escrevi a Canção do exílio longe da minha terra."));
    await run(fetcher, "Recite a Canção do exílio", research);
    expect(research).toHaveBeenCalledTimes(MAX_RESEARCH_CALLS);
    const results = requests[1].messages.at(-1)!.content as ClaudeBlock[];
    expect(String(results[MAX_RESEARCH_CALLS].content)).toContain("limite de pesquisas");
    expect(results.at(-1)).toMatchObject({ tool_use_id: "toolu_acervo", is_error: true });
  });

  it("repairs a reply told in the third person once, then gives up", async () => {
    const { fetcher, requests } = provider((_request, turn) => turn === 1 ? finalReply("Gonçalves Dias nasceu em Caxias.") : finalReply(greeting));
    expect(await run(fetcher)).toEqual({ text: greeting, gesture: "none" });
    expect(requests[1].messages.at(-1)).toMatchObject({ role: "user" });
    expect(String(requests[1].messages.at(-1)!.content)).toContain("primeira pessoa");

    const stubborn = provider(() => finalReply("Gonçalves Dias nasceu em Caxias."));
    await expect(run(stubborn.fetcher)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(stubborn.fetcher).toHaveBeenCalledTimes(2);
  });

  it("reports a safety decline instead of reading its content", async () => {
    const { fetcher } = provider(() => message([], "refusal", { stop_details: { type: "refusal", category: "bio", explanation: null } }));
    const failure = await run(fetcher).catch(error => error);
    expect(failure).toBeInstanceOf(PoetAgentError);
    expect(failure).toMatchObject({ code: "REFUSED", detail: "bio" });
  });

  it("reports how many model calls a reply took, how long each was and what the cache served", async () => {
    const research = vi.fn<Research>(async () => JSON.stringify({ available: false }));
    const { fetcher } = provider((_request, turn) => turn === 1 ? toolCall("pesquisar", { source: "enciclopedia", query: "sabiá" }) : finalReply(greeting));
    const onStats = vi.fn<(stats: ClaudePoetStats) => void>();
    await run(fetcher, "O que é um sabiá?", research, onStats);
    expect(onStats).toHaveBeenCalledTimes(1);
    expect(onStats.mock.calls[0][0]).toMatchObject({ modelCalls: 2, toolCalls: 1, cacheReadTokens: 8000, outputTokens: 40 });
    expect(onStats.mock.calls[0][0].modelMs).toHaveLength(2);
  });

  it("stops at the model-call budget when the tool loop never ends", async () => {
    const research = vi.fn<Research>(async () => JSON.stringify({ available: false }));
    const { fetcher } = provider((_request, turn) => toolCall("pesquisar", { source: "enciclopedia", query: `termo ${turn}` }, `toolu_${turn}`));
    const onStats = vi.fn<(stats: ClaudePoetStats) => void>();
    await expect(run(fetcher, "Oi", research, onStats)).rejects.toMatchObject({ code: "AGENT_LIMIT" });
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(MAX_AGENT_MODEL_CALLS);
    expect(onStats).toHaveBeenCalledTimes(1);
  });
});
