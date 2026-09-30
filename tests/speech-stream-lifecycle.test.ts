import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiHandlers, readConfig } from "../lib/server/api";

const config = () => readConfig({ OPENAI_API_KEY: "openai-test-only" });
const speechRequest = (signal?: AbortSignal) => new Request("http://localhost/api/speech", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "Texto privado do visitante.", format: "pcm" }), signal,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PCM stream lifetime", () => {
  it("keeps receiving healthy audio for longer than the startup timeout", async () => {
    vi.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let signal!: AbortSignal;
    const api = createApiHandlers({ config, timeoutMs: 20, fetch: async (_url, init) => {
      signal = init!.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { source = controller; source.enqueue(new Uint8Array([0, 1])); },
      }), { headers: { "Content-Type": "audio/pcm" } });
    } });
    const response = await api.speech(speechRequest());
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([0, 1]));
    for (let index = 0; index < 6; index++) {
      const next = reader.read();
      await vi.advanceTimersByTimeAsync(15);
      source.enqueue(new Uint8Array([index, index + 1]));
      expect((await next).value).toEqual(new Uint8Array([index, index + 1]));
    }
    source.close();
    expect((await reader.read()).done).toBe(true);
    expect(signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    reader.releaseLock();
  });

  it("does not count time spent waiting for a paused consumer as provider inactivity", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    const api = createApiHandlers({ config, timeoutMs: 20, fetch: async (_url, init) => {
      signal = init!.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      } }), { headers: { "Content-Type": "audio/pcm" } });
    } });
    const response = await api.speech(speechRequest());
    await vi.advanceTimersByTimeAsync(80);
    expect(signal.aborted).toBe(false);
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
    // Let the second chunk fill the output queue, then pause playback again.
    await vi.advanceTimersByTimeAsync(80);
    expect(signal.aborted).toBe(false);
    expect((await reader.read()).value).toEqual(new Uint8Array([3, 4]));
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    reader.releaseLock();
  });

  it("returns a normal timeout response if headers arrive but the first audio never does", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cancel = vi.fn();
    const api = createApiHandlers({ config, timeoutMs: 20, fetch: async () =>
      new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "Content-Type": "audio/pcm" } }),
    });
    const pending = api.speech(speechRequest());
    await vi.advanceTimersByTimeAsync(21);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ error: { code: "PROVIDER_TIMEOUT" } });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still aborts a pending upstream read when no new audio arrives", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let signal!: AbortSignal;
    const cancel = vi.fn();
    const api = createApiHandlers({ config, timeoutMs: 20, fetch: async (_url, init) => {
      signal = init!.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1, 2])); }, cancel,
      }), { headers: { "Content-Type": "audio/pcm" } });
    } });
    const response = await api.speech(speechRequest());
    const reader = response.body!.getReader();
    await reader.read();
    const pending = expect(reader.read()).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(21);
    await pending;
    expect(signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[speech] PCM interrompido:", {
      code: "PROVIDER_TIMEOUT", stage: "streaming", elapsedMs: 20, bytes: 2,
    });
    expect(vi.getTimerCount()).toBe(0);
    reader.releaseLock();
  });

  it("turns a failure before the first audio into safe JSON and a sanitized diagnostic", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = createApiHandlers({ config, fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("private-upstream-error sk-do-not-log-this")); },
    }), { headers: { "Content-Type": "audio/pcm" } }) });
    const response = await api.speech(speechRequest());
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: "PROVIDER_UNAVAILABLE" } });
    expect(log).toHaveBeenCalledWith("[speech] PCM interrompido:", {
      code: "PROVIDER_UNAVAILABLE", stage: "first-audio", elapsedMs: expect.any(Number), bytes: 0,
    });
    const exposed = JSON.stringify([body, log.mock.calls]);
    for (const secret of ["private-upstream-error", "sk-do-not-log-this", "openai-test-only", "Texto privado"]) {
      expect(exposed).not.toContain(secret);
    }
  });

  it("cancels generation while waiting for the first audio", async () => {
    const requestController = new AbortController();
    const cancel = vi.fn();
    let startRead!: () => void;
    const reading = new Promise<void>(resolve => { startRead = resolve; });
    const api = createApiHandlers({ config, fetch: async () => new Response(new ReadableStream<Uint8Array>({
      pull() { startRead(); }, cancel,
    }), { headers: { "Content-Type": "audio/pcm" } }) });
    const pending = api.speech(speechRequest(requestController.signal));
    await reading;
    requestController.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ error: { code: "REQUEST_CANCELLED" } });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
