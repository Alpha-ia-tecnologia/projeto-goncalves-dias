import { describe, expect, it, vi } from "vitest";
import { runPoetAgent } from "../lib/server/poet-agent";

type ProviderMessage = {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
};
type ProviderRequest = { messages: ProviderMessage[]; tools?: { function: { name: string } }[] };

function toolReply(name: string, args: unknown, id = "call_poet") {
  return {
    id: "chatcmpl-poet-test",
    object: "chat.completion",
    created: 1_760_000_000,
    model: "deepseek-flash",
    choices: [{
      index: 0,
      message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
  };
}

const finalReply = (text: string, gesture = "none", id?: string) => toolReply("resposta_do_poeta", { text, gesture }, id);
const greeting = "Eu sou Gonçalves Dias e recebo você com alegria.";

function provider(respond: (request: ProviderRequest, turn: number) => unknown) {
  const requests: ProviderRequest[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    if (typeof body !== "string") throw new Error("Expected a JSON provider request");
    const request = JSON.parse(body) as ProviderRequest;
    requests.push(request);
    return Response.json(respond(request, requests.length));
  });
  return { requests, fetcher };
}

const run = (fetcher: typeof fetch, message = "Olá", history: { role: "user" | "assistant"; content: string }[] = []) => runPoetAgent({
  apiKey: "deepseek-test-only",
  model: "deepseek-flash",
  message,
  history,
  signal: new AbortController().signal,
  fetch: fetcher,
});

describe("Gonçalves Dias agent with the real LangChain loop", () => {
  it("returns a first-person structured answer using the model's final-response tool", async () => {
    const { fetcher, requests } = provider(() => finalReply(greeting, "wave"));
    expect(await run(fetcher)).toEqual({ text: greeting, gesture: "wave" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requests[0].tools?.map(tool => tool.function.name)).toEqual(expect.arrayContaining(["consultar_acervo", "resposta_do_poeta"]));
    expect(requests[0].messages.at(-1)).toMatchObject({ role: "user", content: "Olá" });
  });

  it("executes a collection lookup and supplies its result to the next model turn", async () => {
    const answer = "Eu nasci no Maranhão, em 1823, e fiz da poesia o meu caminho.";
    const { fetcher, requests } = provider((_request, turn) => turn === 1
      ? toolReply("consultar_acervo", { topic: "vida" }, "call_collection")
      : finalReply(answer));
    expect(await run(fetcher, "Onde e quando você nasceu?")).toEqual({ text: answer, gesture: "none" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const lookup = requests[1].messages.find(message => message.role === "tool" && message.tool_call_id === "call_collection");
    expect(lookup?.content).toMatch(/1823/);
    expect(lookup?.content).toMatch(/Maranhão|Caxias/i);
  });

  it("preserves supplied conversation history without carrying it into another request", async () => {
    const { fetcher, requests } = provider(() => finalReply("Eu guardo na poesia as lembranças da minha terra."));
    const history = [
      { role: "user" as const, content: "Vamos conversar sobre a saudade da minha cidade, Alcântara." },
      { role: "assistant" as const, content: "Eu encontro na saudade uma fonte de poesia." },
    ];
    await run(fetcher, "Como você escreveria sobre isso?", history);
    await run(fetcher, "O que é poesia?");
    expect(requests[0].messages.filter(message => message.role !== "system")).toEqual([
      ...history, { role: "user", content: "Como você escreveria sobre isso?" },
    ]);
    expect(JSON.stringify(requests[1].messages)).not.toContain("Alcântara");
    expect(requests[1].messages.at(-1)).toMatchObject({ role: "user", content: "O que é poesia?" });
  });

  it.each([
    "Gonçalves Dias foi um poeta brasileiro. Ele escreveu a Canção do exílio.",
    "Eu penso que Gonçalves Dias foi um poeta brasileiro.",
  ])("repairs a third-person answer before returning it to the visitor: %s", async thirdPerson => {
    const corrected = "Eu sou Gonçalves Dias e escrevi a Canção do exílio.";
    const { fetcher, requests } = provider((_request, turn) => turn === 1
      ? finalReply(thirdPerson, "none", "call_invalid_person")
      : finalReply(corrected, "none", "call_corrected_person"));
    expect((await run(fetcher, "Quem é você?")).text).toBe(corrected);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const correction = requests[1].messages.find(message => message.role === "tool" && message.tool_call_id === "call_invalid_person");
    expect(correction?.content).toMatch(/pessoa|person|valid/i);
  });

  it("ends a repeatedly invalid persona response after a bounded number of model calls", async () => {
    const { fetcher } = provider(() => finalReply("Gonçalves Dias foi um poeta. Ele escreveu versos."));
    await expect(run(fetcher, "Quem é você?")).rejects.toMatchObject({ name: "PoetAgentError", code: "AGENT_LIMIT" });
    expect(fetcher.mock.calls.length).toBeGreaterThan(1);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("lets the model repair a malformed structured gesture rather than exposing it", async () => {
    const answer = "Eu concordo com essa leitura da minha poesia.";
    const { fetcher, requests } = provider((_request, turn) => turn === 1
      ? finalReply(answer, "jump", "call_invalid_gesture")
      : finalReply(answer, "nod", "call_corrected_gesture"));
    expect(await run(fetcher, "Podemos ler o poema dessa maneira?")).toEqual({ text: answer, gesture: "nod" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requests[1].messages.some(message => message.role === "tool" && message.tool_call_id === "call_invalid_gesture")).toBe(true);
  });

  it("recovers from an unavailable tool without executing arbitrary functionality", async () => {
    const answer = "Eu posso conversar sobre os meus poemas e a minha trajetória.";
    const { fetcher, requests } = provider((_request, turn) => turn === 1
      ? toolReply("execute_shell", { command: "do-not-run" }, "call_unknown_tool")
      : finalReply(answer));
    expect((await run(fetcher, "Conte-me sobre os seus poemas.")).text).toBe(answer);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const unavailable = requests[1].messages.find(message => message.role === "tool" && message.tool_call_id === "call_unknown_tool");
    expect(unavailable?.content).toMatch(/not|unknown|inválid|inexist|dispon|error/i);
  });

  it("bounds repeated requests for an unavailable tool", async () => {
    const { fetcher } = provider((_request, turn) => toolReply("unavailable_tool", {}, `call_unknown_${turn}`));
    await expect(run(fetcher, "Conte-me algo.")).rejects.toMatchObject({ name: "PoetAgentError" });
    expect(fetcher.mock.calls.length).toBeGreaterThan(0);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(4);
  });
});