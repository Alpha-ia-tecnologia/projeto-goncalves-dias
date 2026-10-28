import { describe, expect, it, vi } from "vitest";
import { MAX_AGENT_MODEL_CALLS, MAX_RESEARCH_CALLS, PoetAgentError } from "../lib/server/poet-agent";
import { CLAUDE_DEFAULT_MODEL, runClaudePoet } from "../lib/server/poet-claude";

type ClaudeBlock = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type ClaudeRequest = {
  model: string;
  messages: { role: string; content: string | ClaudeBlock[] }[];
  tools?: { name: string; strict?: boolean }[];
  output_config?: { effort?: string; format?: { type: string } };
  fallbacks?: unknown;
  thinking?: unknown;
  temperature?: unknown;
};

const message = (content: ClaudeBlock[], stop_reason: string, extra: Record<string, unknown> = {}) => ({
  id: "msg_poet_test", type: "message", role: "assistant", model: CLAUDE_DEFAULT_MODEL, content, stop_reason,
  stop_sequence: null, usage: { input_tokens: 30, output_tokens: 20 }, ...extra,
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

const run = (fetcher: typeof fetch, text = "Olá", research?: (source: "enciclopedia" | "poema", query: string) => Promise<string>) => runClaudePoet({
  apiKey: "anthropic-test-only",
  model: CLAUDE_DEFAULT_MODEL,
  message: text,
  history: [{ role: "assistant", content: "Bem-vindo ao meu gabinete." }],
  signal: new AbortController().signal,
  fetch: fetcher,
  research,
});

describe("Gonçalves Dias on Claude", () => {
  it("asks Claude Opus 5.5 for the JSON envelope, with low effort, refusal fallbacks and the archive tool", async () => {
    const { fetcher, requests, headers } = provider(() => finalReply(greeting, "wave"));
    expect(await run(fetcher)).toEqual({ text: greeting, gesture: "wave" });
    const [request] = requests;
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.output_config).toMatchObject({ effort: "low", format: { type: "json_schema" } });
    expect(request.fallbacks).toBe("default");
    expect(headers[0].get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    // Opus 5.5 rejects disabled thinking and sampling parameters.
    expect(request.thinking).toBeUndefined();
    expect(request.temperature).toBeUndefined();
    expect(request.tools?.map(tool => tool.name)).toEqual(["consultar_acervo"]);
    expect(request.tools?.every(tool => tool.strict)).toBe(true);
    expect(request.messages.map(entry => entry.role)).toEqual(["assistant", "user"]);
  });

  it("runs an archive lookup and hands the result back in the next turn", async () => {
    const answer = "Eu nasci no Maranhão, em 1823, e fiz da poesia o meu caminho.";
    const { fetcher, requests } = provider((_request, turn) => turn === 1 ? toolCall("consultar_acervo", { topic: "vida" }, "toolu_vida") : finalReply(answer));
    expect(await run(fetcher, "Onde você nasceu?")).toEqual({ text: answer, gesture: "none" });
    const results = requests[1].messages.at(-1)!.content as ClaudeBlock[];
    expect(results[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_vida" });
    expect(String(results[0].content)).toMatch(/1823/);
    // The assistant turn goes back exactly as it came, before the results.
    expect(requests[1].messages.at(-2)).toMatchObject({ role: "assistant", content: [{ type: "tool_use", id: "toolu_vida" }] });
  });

  it("caps public research and reports invalid tool input as an error result", async () => {
    const research = vi.fn(async () => JSON.stringify({ available: true, title: "Canção do exílio" }));
    const calls = Array.from({ length: MAX_RESEARCH_CALLS + 1 }, (_, index) => ({ type: "tool_use", id: `toolu_${index}`, name: "pesquisar", input: { source: "poema", query: "Canção do exílio" } }));
    const { fetcher, requests } = provider((_request, turn) => turn === 1
      ? message([...calls, { type: "tool_use", id: "toolu_bad", name: "consultar_acervo", input: { topic: "inexistente" } }], "tool_use")
      : finalReply("Eu escrevi a Canção do exílio longe da minha terra."));
    await run(fetcher, "Recite a Canção do exílio", research);
    expect(research).toHaveBeenCalledTimes(MAX_RESEARCH_CALLS);
    const results = requests[1].messages.at(-1)!.content as ClaudeBlock[];
    expect(String(results[MAX_RESEARCH_CALLS].content)).toContain("limite de pesquisas");
    expect(results.at(-1)).toMatchObject({ tool_use_id: "toolu_bad", is_error: true });
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

  it("stops at the model-call budget when the tool loop never ends", async () => {
    const { fetcher } = provider((_request, turn) => toolCall("consultar_acervo", { topic: "vida" }, `toolu_${turn}`));
    await expect(run(fetcher)).rejects.toMatchObject({ code: "AGENT_LIMIT" });
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(MAX_AGENT_MODEL_CALLS);
  });
});
