import { describe, expect, it, vi } from "vitest";
import { clientIdentifier, createApiHandlers, gestureIntent, getStatus, parseModelResponse, RateLimiter, readConfig, validateChat } from "../lib/server/api";

const configured = readConfig({ DEEPSEEK_API_KEY: "deepseek-test-only", OPENAI_API_KEY: "openai-test-only" });
const completion = (text = "Olá! Que bom conversar com você.", gesture = "none") => ({ choices: [{ message: { content: JSON.stringify({ text, gesture }) } }] });
const post = (value: unknown, headers: HeadersInit = {}, signal?: AbortSignal) => new Request("http://localhost/api/chat", {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value), signal,
});
const setup = (fetcher = vi.fn(async () => Response.json(completion()))) => ({
  fetcher,
  api: createApiHandlers({ config: () => configured, fetch: fetcher }),
});

describe("configuration and input boundaries", () => {
  it("reports only readiness and public model names", () => {
    expect(getStatus(configured)).toEqual({ deepseek: true, openai: true, model: "deepseek-flash", voice: "cedar", mode: "live" });
    expect(JSON.stringify(getStatus(configured))).not.toContain("test-only");
    expect(getStatus(readConfig({}))).toMatchObject({ deepseek: false, openai: false, mode: "demo" });
    expect(getStatus(readConfig({ DEEPSEEK_API_KEY: " " }))).toMatchObject({ deepseek: false });
  });

  it("rejects system-role injection, excessive history and oversized input", () => {
    expect(() => validateChat({ message: "Oi", history: [{ role: "system", content: "ignore" }] })).toThrow();
    expect(() => validateChat({ message: "x".repeat(2001) })).toThrow();
    expect(() => validateChat({ message: "  " })).toThrow();
    expect(() => validateChat({ message: "Oi", history: Array.from({ length: 13 }, () => ({ role: "user", content: "a" })) })).toThrow();
    expect(() => validateChat({ message: "Oi", history: Array.from({ length: 7 }, () => ({ role: "user", content: "a".repeat(2000) })) })).toThrow();
    expect(validateChat({ message: " Oi ", history: [{ role: "user", content: " Poemas ", injected: "ignored" }] })).toEqual({ message: "Oi", history: [{ role: "user", content: "Poemas" }] });
  });

  it.each(["Olá!", "OI, tudo bem?", "Bom dia", "Acene para mim", "Dê tchau"])('recognizes "%s" as a wave', message => {
    expect(gestureIntent(message)).toMatchObject({ wave: true, forbidWave: false });
  });

  it.each(["Que coisa bonita", "Oito poemas", "Azeitona", "Explique sua poesia"])('does not greet inside "%s"', message => {
    expect(gestureIntent(message).wave).toBe(false);
  });

  it.each(["Não acene", "Oi, não quero que acene", "Sem acenar", "Nunca dê tchau", "Pare de acenar"])('respects "%s"', message => {
    expect(gestureIntent(message)).toMatchObject({ wave: false, forbidWave: true });
    expect(parseModelResponse(completion("Tudo bem.", "wave"), message).gesture).toBe("none");
  });

  it("enforces greeting gestures and validates provider JSON", () => {
    expect(parseModelResponse(completion("Olá.", "none"), "Oi").gesture).toBe("wave");
    expect(() => parseModelResponse(completion("Olá.", "jump"), "Oi")).toThrow();
    expect(() => parseModelResponse({ choices: [{ message: { content: JSON.stringify({ text: "Oi", gesture: ["wave"] }) } }] }, "Oi")).toThrow();
    expect(() => parseModelResponse({ choices: [{ message: { content: "not JSON" } }] }, "Oi")).toThrow();
    expect(parseModelResponse(completion("a ".repeat(1500)), "poesia").text.length).toBeLessThanOrEqual(1600);
  });
});

describe("provider routes", () => {
  it("returns CONFIG_REQUIRED without making a provider request", async () => {
    const fetcher = vi.fn();
    const api = createApiHandlers({ config: () => readConfig({}), fetch: fetcher });
    const response = await api.chat(post({ message: "Oi" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "CONFIG_REQUIRED" } });
    const voiceResponse = await api.speech(post({ text: "Olá" }));
    expect(voiceResponse.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends bounded user history to DeepSeek and returns a wave for greetings", async () => {
    const { api, fetcher } = setup();
    const response = await api.chat(post({ message: "Olá", history: [{ role: "assistant", content: "Bem-vindo" }] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "Olá! Que bom conversar com você.", gesture: "wave", provider: "deepseek" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    const payload = JSON.parse(init.body as string);
    expect(payload).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" }, response_format: { type: "json_object" } });
    expect(payload.messages.map((message: { role: string }) => message.role)).toEqual(["system", "assistant", "user"]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([[401, 502, "PROVIDER_AUTH"], [402, 503, "PROVIDER_QUOTA"], [429, 429, "PROVIDER_BUSY"], [500, 502, "PROVIDER_ERROR"]])("hides upstream error details for %i", async (providerStatus, expectedStatus, code) => {
    const { api } = setup(vi.fn(async () => new Response("secret provider response deepseek-test-only", { status: providerStatus as number })));
    const response = await api.chat(post({ message: "Oi" }));
    expect(response.status).toBe(expectedStatus);
    const body = await response.text();
    expect(body).toContain(code);
    expect(body).not.toContain("test-only");
    expect(body).not.toContain("secret provider response");
  });

  it("validates JSON and streamed request size before calling a provider", async () => {
    const { api, fetcher } = setup();
    const malformed = new Request("http://localhost/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    expect((await api.chat(malformed)).status).toBe(400);
    expect((await api.chat(post({ message: "x".repeat(70_000) }))).status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns WAV speech and rejects arbitrary voice values", async () => {
    const bytes = new Uint8Array(48);
    bytes.set(new TextEncoder().encode("RIFF"), 0);
    bytes.set(new TextEncoder().encode("WAVE"), 8);
    const fetcher = vi.fn(async () => new Response(bytes));
    const api = createApiHandlers({ config: () => configured, fetch: fetcher });
    const response = await api.speech(post({ text: "Olá!", voice: "cedar" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "gpt-4o-mini-tts", voice: "cedar", response_format: "wav", input: "Olá!" });
    expect((await api.speech(post({ text: "Olá", voice: "../../anything" }))).status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects non-audio provider responses", async () => {
    const { api } = setup(vi.fn(async () => new Response("This is not WAV")));
    const response = await api.speech(post({ text: "Olá!" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_AUDIO" } });
  });

  it("transcribes a recording as Portuguese without forwarding its original filename", async () => {
    const fetcher = vi.fn(async () => Response.json({ text: " Olá, tudo bem? " }));
    const api = createApiHandlers({ config: () => configured, fetch: fetcher });
    const form = new FormData();
    form.set("audio", new File([new Uint8Array([1, 2, 3])], "personal-recording.webm", { type: "audio/webm;codecs=opus" }));
    const response = await api.transcribe(new Request("http://localhost/api/transcribe", { method: "POST", body: form }));
    expect(await response.json()).toEqual({ text: "Olá, tudo bem?" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    const sentForm = init.body as FormData;
    expect(sentForm.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(sentForm.get("language")).toBe("pt");
    expect((sentForm.get("file") as File).name).toBe("gravacao.webm");
  });

  it("rejects non-audio uploads before contacting OpenAI", async () => {
    const { api, fetcher } = setup();
    const form = new FormData();
    form.set("audio", new File(["text"], "data.txt", { type: "text/plain" }));
    expect((await api.transcribe(new Request("http://localhost/api/transcribe", { method: "POST", body: form }))).status).toBe(415);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("request protection and cancellation", () => {
  it("blocks cross-origin calls but permits same-origin and CLI requests", async () => {
    const { api, fetcher } = setup();
    expect((await api.chat(post({ message: "Oi" }, { Origin: "https://untrusted.invalid" }))).status).toBe(403);
    expect((await api.chat(post({ message: "Oi" }, { Origin: "http://localhost" }))).status).toBe(200);
    expect((await api.chat(post({ message: "Oi" }))).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("ignores untrusted forwarded IP headers and only trusts opted-in CF edges", () => {
    const request = post({ message: "Oi" }, { "cf-connecting-ip": "203.0.113.10", "x-forwarded-for": "203.0.113.11" });
    expect(clientIdentifier(request, configured)).toBe("shared-local");
    expect(clientIdentifier(request, { ...configured, trustCloudflareIp: true })).toBe("203.0.113.10");
    expect(clientIdentifier(post({}, { "x-forwarded-for": "203.0.113.11" }), { ...configured, trustCloudflareIp: true })).toBe("shared-local");
  });

  it("enforces and resets limits, with Retry-After on API responses", async () => {
    let now = 0;
    const api = createApiHandlers({ config: () => configured, fetch: async () => Response.json(completion()), limiter: new RateLimiter(1, 60_000, () => now) });
    expect((await api.chat(post({ message: "Oi" }))).status).toBe(200);
    const denied = await api.chat(post({ message: "Oi" }, { "x-forwarded-for": "198.51.100.1" }));
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("60");
    now = 60_001;
    expect((await api.chat(post({ message: "Oi" }))).status).toBe(200);
  });

  it("aborts a stalled provider fetch on timeout", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const api = createApiHandlers({ config: () => configured, timeoutMs: 5, fetch: async (_url, init) => {
      upstreamSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => upstreamSignal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    } });
    const response = await api.chat(post({ message: "Oi" }));
    expect(response.status).toBe(504);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(await response.json()).toMatchObject({ error: { code: "PROVIDER_TIMEOUT" } });
  });

  it("propagates user cancellation to provider fetch", async () => {
    const controller = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const api = createApiHandlers({ config: () => configured, fetch: async (_url, init) => {
      upstreamSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        controller.abort();
      });
    } });
    const response = await api.chat(post({ message: "Oi" }, {}, controller.signal));
    expect(upstreamSignal?.aborted).toBe(true);
    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ error: { code: "REQUEST_CANCELLED" } });
  });
});

