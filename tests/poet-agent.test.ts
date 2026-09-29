import { describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { MAX_AGENT_MODEL_CALLS, MAX_RESEARCH_CALLS, PoetReplySchema, recoverStructuredReply, runPoetAgent } from "../lib/server/poet-agent";
import { lookupPoetKnowledge, POET_KNOWLEDGE_TOPICS } from "../lib/server/poet-persona";

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
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(MAX_AGENT_MODEL_CALLS);
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
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(MAX_AGENT_MODEL_CALLS);
  });

  it("offers the school topic and feeds its facts into the next model turn", async () => {
    const answer = "Eu pertenço à escola EDUCAPRIME, em São Luís do Maranhão, e é ela que me acolhe aqui.";
    const { fetcher, requests } = provider((_request, turn) => turn === 1
      ? toolReply("consultar_acervo", { topic: "escola" }, "call_school")
      : finalReply(answer));
    expect((await run(fetcher, "De qual escola você é?")).text).toBe(answer);
    expect(JSON.stringify(requests[0].tools?.find(tool => tool.function.name === "consultar_acervo"))).toContain("escola");
    const lookup = requests[1].messages.find(message => message.role === "tool" && message.tool_call_id === "call_school");
    expect(lookup?.content).toMatch(/Escola Educa Prime/);
    expect(lookup?.content).toMatch(/São Luís/);
    expect(lookup?.content).toContain("24.627.384/0001-35");
    expect(lookup?.content).toContain("Letria");
    expect(lookup?.content).toContain("pensamento computacional");
  });

  it("instructs the poet to name EDUCAPRIME whenever he introduces himself", async () => {
    const { fetcher, requests } = provider(() => finalReply("Sou Gonçalves Dias, poeta maranhense, e pertenço à escola EDUCAPRIME."));
    await run(fetcher, "Quem é você?");
    const instructions = JSON.stringify(requests[0].messages.find(message => message.role === "system")?.content ?? "");
    expect(instructions).toContain("EDUCAPRIME");
    expect(instructions).toMatch(/[Ss]empre que se apresentar/);
    expect(instructions).toContain("tema escola");
    // Insider voice, never the language of a lookup.
    expect(instructions).toMatch(/nossa escola/);
    expect(instructions).toMatch(/segundo os registros/);
  });
});

describe("pesquisa para responder com precisão", () => {
  const found = JSON.stringify({ available: true, source: "Wikipédia", title: "Gonçalves Dias", passages: "Várias de suas peças românticas, inclusive \"Ainda uma vez — Adeus\" foram escritas para Ana Amélia Ferreira Vale." });

  it("oferece pesquisar, executa a consulta pedida pelo modelo e entrega o resultado ao turno seguinte", async () => {
    const answer = "Esse poema é meu: escrevi Ainda uma vez — Adeus pensando em Ana Amélia.";
    const research = vi.fn(async () => found);
    const { fetcher, requests } = provider((_request, turn) => turn === 1
      ? toolReply("pesquisar", { source: "enciclopedia", query: "Ainda uma vez adeus Gonçalves Dias" }, "call_research")
      : finalReply(answer));
    const result = await runPoetAgent({ apiKey: "deepseek-test-only", model: "deepseek-flash", message: "A quem pertence Ainda uma vez, adeus?", history: [], signal: new AbortController().signal, fetch: fetcher, research });

    expect(result.text).toBe(answer);
    expect(research).toHaveBeenCalledWith("enciclopedia", "Ainda uma vez adeus Gonçalves Dias");
    expect(requests[0].tools?.map(tool => tool.function.name)).toEqual(expect.arrayContaining(["consultar_acervo", "pesquisar", "resposta_do_poeta"]));
    const toolMessage = requests[1].messages.find(message => message.role === "tool" && message.tool_call_id === "call_research");
    expect(toolMessage?.content).toContain("Ana Amélia Ferreira Vale");
  });

  it("limita as pesquisas de uma resposta, mesmo pedidas todas de uma vez", async () => {
    const research = vi.fn(async () => found);
    const calls = Array.from({ length: 5 }, (_, index) => ({ id: `call_many_${index}`, type: "function", function: { name: "pesquisar", arguments: JSON.stringify({ source: "enciclopedia", query: `assunto ${index}` }) } }));
    const { fetcher, requests } = provider((_request, turn) => turn === 1
      ? { ...toolReply("pesquisar", {}), choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: calls }, finish_reason: "tool_calls" }] }
      : finalReply(greeting));
    await runPoetAgent({ apiKey: "deepseek-test-only", model: "deepseek-flash", message: "Oi", history: [], signal: new AbortController().signal, fetch: fetcher, research });
    expect(research).toHaveBeenCalledTimes(MAX_RESEARCH_CALLS);
    const refused = requests[1].messages.filter(message => message.role === "tool" && /limite de pesquisas/.test(message.content ?? ""));
    expect(refused).toHaveLength(5 - MAX_RESEARCH_CALLS);
  });

  it("não oferece pesquisar quando o servidor não fornece a pesquisa", async () => {
    const { fetcher, requests } = provider(() => finalReply(greeting, "wave"));
    await run(fetcher);
    expect(requests[0].tools?.map(tool => tool.function.name)).not.toContain("pesquisar");
  });

  it("recusa uma consulta vazia antes de ela sair do servidor", async () => {
    const research = vi.fn(async () => found);
    const { fetcher } = provider((_request, turn) => turn === 1
      ? toolReply("pesquisar", { source: "enciclopedia", query: "" }, "call_empty")
      : finalReply(greeting));
    await runPoetAgent({ apiKey: "deepseek-test-only", model: "deepseek-flash", message: "Oi", history: [], signal: new AbortController().signal, fetch: fetcher, research });
    expect(research).not.toHaveBeenCalled();
  });

  it("instrui o poeta a pesquisar o que o acervo não cobre, e nunca a escola", async () => {
    const { fetcher, requests } = provider(() => finalReply(greeting));
    await runPoetAgent({ apiKey: "deepseek-test-only", model: "deepseek-flash", message: "Oi", history: [], signal: new AbortController().signal, fetch: fetcher, research: vi.fn(async () => found) });
    const instructions = JSON.stringify(requests[0].messages.find(message => message.role === "system")?.content ?? "");
    expect(instructions).toContain("pesquisar");
    expect(instructions).toMatch(/Nunca use pesquisar para a escola/);
    expect(instructions).toMatch(/Ajuste o tamanho/);
  });
});

describe("respostas a perguntas de todo tipo", () => {
  it.each([
    "Para mim, o poeta é quem escuta o mundo e devolve em versos o que ouviu.",
    "Nossa escola fica em São Luís, e nossos alunos aprendem brincando.",
    "Sete vezes oito dá cinquenta e seis; confesso que prefiro contar sílabas a contar números.",
    "Deixe-me pensar: a capital do Maranhão é São Luís.",
  ])("aceita uma fala legítima em primeira pessoa: %s", text => {
    expect(PoetReplySchema.safeParse({ text, gesture: "none" }).success).toBe(true);
  });

  it.each([
    "Gonçalves Dias nasceu em Caxias, e eu gosto de lembrar disso.",
    "O poeta nasceu em Caxias e publicou Primeiros cantos.",
    "A capital do Maranhão é São Luís.",
  ])("continua recusando narração em terceira pessoa ou fala sem primeira pessoa: %s", text => {
    expect(PoetReplySchema.safeParse({ text, gesture: "none" }).success).toBe(false);
  });
});

describe("EDUCAPRIME entry of the server-owned collection", () => {
  const escola = JSON.parse(lookupPoetKnowledge("escola")) as { available: boolean; facts: string; sources: string[] };

  it("exposes escola as a consultable topic", () => {
    expect(POET_KNOWLEDGE_TOPICS).toContain("escola");
    expect(escola.available).toBe(true);
    expect(escola.sources.length).toBeGreaterThan(0);
  });

  it("records the registry identity and the three units of the school", () => {
    expect(escola.facts).toContain("Escola Educa Prime");
    expect(escola.facts).toContain("24.627.384/0001-35");
    expect(escola.facts).toContain("19 de abril de 2016");
    for (const unit of ["Turu", "Calhau", "Cohatrac"]) expect(escola.facts).toContain(unit);
  });

  it("announces the Letria literacy platform and computational thinking as ours", () => {
    expect(escola.facts).toContain("Letria");
    expect(escola.facts).toMatch(/perfil de cada aluno/);
    expect(escola.facts).toMatch(/interven/i);
    expect(escola.facts).toContain("pensamento computacional");
    expect(escola.facts).toMatch(/Educação Infantil/);
  });

  it("states the school as one of its own, without the language of a lookup", () => {
    expect(escola.facts).toMatch(/nossa escola|nossas unidades|nossos alunos/);
    for (const hedge of [/segundo os registros/i, /consta que/i, /ao que parece/i, /a confirmar/i, /depende[m]? de confirmação/i])
      expect(escola.facts).not.toMatch(hedge);
  });
});
describe("quando o agente responde sem o envelope", () => {
  it("recupera a última fala do poeta em vez de perder a resposta", () => {
    const recovered = recoverStructuredReply([
      new HumanMessage("quem és tu"),
      new AIMessage("Sou Gonçalves Dias, poeta maranhense."),
    ]);
    expect(recovered).toEqual({ text: "Sou Gonçalves Dias, poeta maranhense.", gesture: "none" });
    // And it still has to pass every rule: the envelope is rebuilt, not the text.
    expect(PoetReplySchema.safeParse(recovered).success).toBe(true);
  });

  it("lê também o conteúdo entregue em blocos", () => {
    const recovered = recoverStructuredReply([
      new AIMessage({ content: [{ type: "text", text: "Escrevi a Canção do exílio em 1843." }] }),
    ]);
    expect(recovered).toEqual({ text: "Escrevi a Canção do exílio em 1843.", gesture: "none" });
  });

  it("não inventa nada quando não há fala nenhuma a recuperar", () => {
    expect(recoverStructuredReply([new AIMessage("")])).toBeUndefined();
    expect(recoverStructuredReply([new HumanMessage("olá")])).toBeUndefined();
    expect(recoverStructuredReply(undefined)).toBeUndefined();
    // A recovered text that breaks the rules is still refused downstream.
    const thirdPerson = recoverStructuredReply([new AIMessage("Gonçalves Dias foi um poeta romântico.")]);
    expect(PoetReplySchema.safeParse(thirdPerson).success).toBe(false);
  });
});
