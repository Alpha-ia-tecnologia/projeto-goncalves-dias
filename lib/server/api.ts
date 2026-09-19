import { PoetAgentError, runPoetAgent } from "./poet-agent";
import { VOICES, type ChatMessage, type ChatResponse, type Gesture, type ServiceStatus } from "../contracts";

export interface ServerConfig {
  deepseekKey?: string;
  openaiKey?: string;
  deepseekModel: string;
  ttsModel: string;
  voice: string;
  trustCloudflareIp: boolean;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type EnvValues = Record<string, unknown>;
const MAX_MESSAGE = 2_000;
const MAX_RESPONSE = 1_600;
const MAX_HISTORY = 12;
const MAX_HISTORY_CHARS = 12_000;
const MAX_AUDIO = 8 * 1024 * 1024;
const JSON_LIMIT = 64 * 1024;
const UPSTREAM_JSON_LIMIT = 128 * 1024;


class ApiError extends Error {
  status: number;
  code: string;
  retryAfter?: number;

  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function readConfig(env: EnvValues): ServerConfig {
  const value = (key: string, fallback = "") => typeof env[key] === "string" ? (env[key] as string).trim() : fallback;
  return {
    deepseekKey: value("DEEPSEEK_API_KEY") || undefined,
    openaiKey: value("OPENAI_API_KEY") || undefined,
    deepseekModel: value("DEEPSEEK_MODEL") || "deepseek-flash",
    ttsModel: value("OPENAI_TTS_MODEL") || "gpt-4o-mini-tts",
    voice: value("OPENAI_TTS_VOICE") || "cedar",
    trustCloudflareIp: value("TRUST_PROXY_HEADERS") === "cloudflare",
  };
}

export function getStatus(config: ServerConfig): ServiceStatus {
  return {
    deepseek: Boolean(config.deepseekKey),
    openai: Boolean(config.openaiKey),
    model: config.deepseekModel,
    voice: config.voice,
    mode: config.deepseekKey && config.openaiKey ? "live" : "demo",
  };
}

export function gestureIntent(message: string): { wave: boolean; forbidWave: boolean } {
  const text = message.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const forbidWave = /\b(?:nao|sem|nunca)\b(?:[\s,]+\w+){0,5}[\s,]+(?:acen\w*|tchau|cumpriment\w*)\b/.test(text)
    || /\b(?:pare|parar|evite)\b(?:\s+\w+){0,3}\s+acen\w*\b/.test(text);
  const wave = !forbidWave && /\b(?:ola|oi|oie|bom dia|boa tarde|boa noite|tudo bem|tchau|acen[ae](?:r|ndo)?|acene)\b/.test(text);
  return { wave, forbidWave };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textInput(value: unknown, limit: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new ApiError(400, "INVALID_INPUT", `${field} deve ter entre 1 e ${limit} caracteres.`);
  }
  return value.trim();
}

export function validateChat(value: unknown): { message: string; history: ChatMessage[] } {
  if (!isObject(value)) throw new ApiError(400, "INVALID_INPUT", "Envie uma mensagem válida.");
  const message = textInput(value.message, MAX_MESSAGE, "A mensagem");
  const historyValue = value.history ?? [];
  if (!Array.isArray(historyValue) || historyValue.length > MAX_HISTORY) {
    throw new ApiError(400, "INVALID_INPUT", `O histórico deve ter no máximo ${MAX_HISTORY} mensagens.`);
  }
  let historyChars = 0;
  const history = historyValue.map((item): ChatMessage => {
    if (!isObject(item) || (item.role !== "user" && item.role !== "assistant")) {
      throw new ApiError(400, "INVALID_INPUT", "O histórico aceita apenas mensagens de usuário e assistente.");
    }
    const content = textInput(item.content, MAX_MESSAGE, "Cada mensagem do histórico");
    historyChars += content.length;
    return { role: item.role, content };
  });
  if (historyChars > MAX_HISTORY_CHARS) {
    throw new ApiError(400, "INVALID_INPUT", "O histórico ficou muito longo. Inicie uma nova conversa.");
  }
  return { message, history };
}

export function parseAgentResponse(parsed: unknown, message: string): ChatResponse {
  if (!isObject(parsed) || typeof parsed.text !== "string" || !parsed.text.trim()
    || typeof parsed.gesture !== "string" || !["wave", "nod", "none"].includes(parsed.gesture)) {
    throw new ApiError(502, "INVALID_RESPONSE", "A resposta da IA não pôde ser interpretada.");
  }
  let text = parsed.text.trim();
  if (text.length > MAX_RESPONSE) {
    const prefix = text.slice(0, MAX_RESPONSE - 1);
    const lastSpace = prefix.lastIndexOf(" ");
    text = `${prefix.slice(0, lastSpace > MAX_RESPONSE - 120 ? lastSpace : prefix.length).trimEnd()}…`;
  }
  const intent = gestureIntent(message);
  const gesture: Gesture = intent.forbidWave && parsed.gesture === "wave" ? "none"
    : intent.wave ? "wave" : parsed.gesture as Gesture;
  return { text, gesture, provider: "deepseek" };
}

/** Per-isolate, fixed-window protection. Not a distributed production quota. */
export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private limit: number;
  private windowMs: number;
  private now: () => number;

  constructor(limit = 30, windowMs = 60_000, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  check(key: string) {
    const now = this.now();
    for (const [id, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(id);
    const bucket = this.buckets.get(key);
    if (bucket && bucket.count >= this.limit) {
      throw new ApiError(429, "RATE_LIMITED", "Muitas solicitações. Aguarde um instante e tente novamente.", Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
    }
    if (bucket) bucket.count += 1;
    else {
      // Refuse new buckets instead of evicting active quotas under load.
      if (this.buckets.size >= 1_000) throw new ApiError(429, "RATE_LIMITED", "O serviço está ocupado. Tente novamente em instantes.", 60);
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
    }
  }
}

export function clientIdentifier(request: Request, config: ServerConfig): string {
  // X-Forwarded-For is intentionally ignored. Enable CF header only behind a
  // trusted Cloudflare edge that overwrites it. Local/untrusted traffic shares a quota.
  const candidate = config.trustCloudflareIp ? request.headers.get("cf-connecting-ip") : null;
  return candidate && /^[0-9a-f:.]{3,45}$/i.test(candidate) ? candidate : "shared-local";
}

function json(value: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extraHeaders } });
}

function errorResponse(error: unknown): Response {
  const known = error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR", "Não foi possível concluir a solicitação. Tente novamente.");
  return json({ error: { code: known.code, message: known.message } }, known.status,
    known.retryAfter ? { "Retry-After": String(known.retryAfter) } : undefined);
}

async function readLimited(body: ReadableStream<Uint8Array> | null, max: number, tooLarge: ApiError): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) { await reader.cancel(); throw tooLarge; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

async function requestBytes(request: Request, max: number): Promise<Uint8Array> {
  const length = Number(request.headers.get("content-length"));
  const error = new ApiError(413, "INPUT_TOO_LARGE", "O conteúdo enviado ultrapassa o limite permitido.");
  if (length > max) throw error;
  return readLimited(request.body, max, error);
}

async function requestJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "INVALID_CONTENT_TYPE", "Envie o conteúdo no formato JSON.");
  }
  const bytes = await requestBytes(request, JSON_LIMIT);
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch {
    throw new ApiError(400, "INVALID_JSON", "O conteúdo JSON não é válido.");
  }
}

function verifyOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError(403, "ORIGIN_DENIED", "Esta solicitação precisa partir do próprio aplicativo.");
  }
}

function requireKey(key: string | undefined, provider: "DeepSeek" | "OpenAI"): string {
  if (!key) throw new ApiError(503, "CONFIG_REQUIRED", `A conexão com ${provider} ainda não foi configurada no servidor.`);
  return key;
}

function upstreamError(status: number, provider: string): ApiError {
  if (status === 401 || status === 403) return new ApiError(502, "PROVIDER_AUTH", `Não foi possível autenticar no ${provider}. Verifique a configuração do servidor.`);
  if (status === 402) return new ApiError(503, "PROVIDER_QUOTA", `O ${provider} está sem saldo disponível. Verifique a conta do serviço.`);
  if (status === 429) return new ApiError(429, "PROVIDER_BUSY", `O ${provider} atingiu o limite de uso. Tente novamente em instantes.`, 30);
  return new ApiError(502, "PROVIDER_ERROR", `O ${provider} não conseguiu concluir a solicitação. Tente novamente.`);
}

export function createApiHandlers(options: {
  config: () => ServerConfig;
  fetch?: Fetcher;
  limiter?: RateLimiter;
  timeoutMs?: number;
}) {
  const fetcher = options.fetch ?? fetch;
  const limiter = options.limiter ?? new RateLimiter();
  const timeoutMs = options.timeoutMs ?? 45_000;

  async function upstream<T>(request: Request, url: string, init: RequestInit, provider: string, consume: (response: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    if (request.signal.aborted) cancel();
    request.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetcher(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw upstreamError(response.status, provider);
      }
      return await consume(response);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (timedOut) throw new ApiError(504, "PROVIDER_TIMEOUT", `O ${provider} demorou para responder. Tente novamente.`);
      if (request.signal.aborted) throw new ApiError(499, "REQUEST_CANCELLED", "A solicitação foi interrompida.");
      throw new ApiError(502, "PROVIDER_UNAVAILABLE", `Não foi possível conectar ao ${provider}. Tente novamente.`);
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", cancel);
    }
  }

  async function upstreamJson(response: Response): Promise<unknown> {
    const bytes = await readLimited(response.body, UPSTREAM_JSON_LIMIT, new ApiError(502, "INVALID_RESPONSE", "O serviço retornou uma resposta muito grande."));
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch {
      throw new ApiError(502, "INVALID_RESPONSE", "O serviço retornou uma resposta inesperada.");
    }
  }

  function route(name: string, handler: (request: Request, config: ServerConfig) => Promise<Response>) {
    return async (request: Request): Promise<Response> => {
      try {
        const config = options.config();
        verifyOrigin(request);
        limiter.check(`${name}:${clientIdentifier(request, config)}`);
        return await handler(request, config);
      } catch (error) { return errorResponse(error); }
    };
  }

  const chat = route("chat", async (request, config) => {
    const { message, history } = validateChat(await requestJson(request));
    const key = requireKey(config.deepseekKey, "DeepSeek");
    const controller = new AbortController();
    let timedOut = false;
    let transportError: ApiError | undefined;
    const cancel = () => controller.abort(request.signal.reason);
    if (request.signal.aborted) cancel();
    request.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

    // All steps share one deadline; the SDK uses this bounded transport, with
    // retries disabled. Provider details and credentials never reach the client.
    const agentFetch: typeof fetch = async (url, init) => {
      try {
        controller.signal.throwIfAborted();
        const signal = init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
        const response = await fetcher(url, { ...init, signal });
        if (!response.ok) {
          await response.body?.cancel();
          throw upstreamError(response.status, "DeepSeek");
        }
        const bytes = await readLimited(response.body, UPSTREAM_JSON_LIMIT,
          new ApiError(502, "INVALID_RESPONSE", "O serviço retornou uma resposta muito grande."));
        try { JSON.parse(new TextDecoder().decode(bytes)); } catch {
          throw new ApiError(502, "INVALID_RESPONSE", "O serviço retornou uma resposta inesperada.");
        }
        return new Response(bytes as BodyInit, { status: response.status, headers: response.headers });
      } catch (error) {
        transportError = error instanceof ApiError ? error
          : new ApiError(502, "PROVIDER_UNAVAILABLE", "Não foi possível conectar ao DeepSeek. Tente novamente.");
        throw transportError;
      }
    };

    let onAbort: (() => void) | undefined;
    try {
      controller.signal.throwIfAborted();
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new DOMException("A solicitação foi interrompida.", "AbortError"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      const result = await Promise.race([
        runPoetAgent({ apiKey: key, model: config.deepseekModel, message, history,
          signal: controller.signal, fetch: agentFetch }),
        cancelled,
      ]);
      return json(parseAgentResponse(result, message));
    } catch (error) {
      if (timedOut) throw new ApiError(504, "PROVIDER_TIMEOUT", "O poeta demorou para responder. Tente novamente.");
      if (request.signal.aborted) throw new ApiError(499, "REQUEST_CANCELLED", "A solicitação foi interrompida.");
      if (transportError) throw transportError;
      if (error instanceof PoetAgentError && error.code === "AGENT_LIMIT") {
        throw new ApiError(502, "AGENT_LIMIT", "Não consegui concluir minha resposta. Pode reformular sua pergunta?");
      }
      throw new ApiError(502, "INVALID_RESPONSE", "Não consegui preparar minha resposta. Tente novamente.");
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", cancel);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
  });

  const speech = route("speech", async (request, config) => {
    const input = await requestJson(request);
    if (!isObject(input)) throw new ApiError(400, "INVALID_INPUT", "Envie um texto para gerar a voz.");
    const text = textInput(input.text, MAX_RESPONSE, "O texto da fala");
    const voice = input.voice ?? config.voice;
    if (typeof voice !== "string" || !VOICES.includes(voice as typeof VOICES[number])) {
      throw new ApiError(400, "INVALID_VOICE", "A voz selecionada não é válida.");
    }
    const key = requireKey(config.openaiKey, "OpenAI");
    const audio = await upstream(request, "https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ttsModel, input: text, voice, response_format: "wav",
        instructions: "Fale em português brasileiro, com voz masculina calma, acolhedora e expressiva. Dicção natural e ritmo moderado. Use pausas breves e uma discreta sensibilidade poética, sem teatralidade exagerada.",
      }),
    }, "OpenAI", async response => {
      const bytes = await readLimited(response.body, 20 * 1024 * 1024, new ApiError(502, "INVALID_RESPONSE", "O áudio retornado ultrapassou o tamanho permitido."));
      if (bytes.length < 44 || new TextDecoder().decode(bytes.subarray(0, 4)) !== "RIFF" || new TextDecoder().decode(bytes.subarray(8, 12)) !== "WAVE") {
        throw new ApiError(502, "INVALID_AUDIO", "Não foi possível gerar um áudio válido. Tente novamente.");
      }
      return bytes;
    });
    return new Response(audio as BodyInit, { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  });

  const transcribe = route("transcribe", async (request, config) => {
    const key = requireKey(config.openaiKey, "OpenAI");
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
      throw new ApiError(415, "INVALID_CONTENT_TYPE", "Envie a gravação como um arquivo de áudio.");
    }
    const bytes = await requestBytes(request, MAX_AUDIO + JSON_LIMIT);
    let form: FormData;
    try { form = await new Response(bytes as BodyInit, { headers: { "Content-Type": request.headers.get("content-type")! } }).formData(); } catch {
      throw new ApiError(400, "INVALID_AUDIO", "Não foi possível ler a gravação enviada.");
    }
    const file = form.get("audio");
    if (!(file instanceof File) || !file.size || file.size > MAX_AUDIO) {
      throw new ApiError(400, "INVALID_AUDIO", "Envie uma gravação de áudio de até 8 MB.");
    }
    const mime = file.type.split(";")[0].toLowerCase();
    const extensions: Record<string, string> = { "audio/webm": "webm", "video/webm": "webm", "audio/mp4": "mp4", "video/mp4": "mp4", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac" };
    if (!extensions[mime]) throw new ApiError(415, "INVALID_AUDIO", "Formato não suportado. Use WebM, MP4, MP3, WAV, OGG ou FLAC.");
    const upload = new FormData();
    upload.append("file", file, `gravacao.${extensions[mime]}`);
    upload.append("model", "gpt-4o-mini-transcribe");
    upload.append("language", "pt");
    upload.append("response_format", "json");
    const result = await upstream(request, "https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${key}` }, body: upload,
    }, "OpenAI", upstreamJson);
    if (!isObject(result) || typeof result.text !== "string" || !result.text.trim()) {
      throw new ApiError(422, "NO_SPEECH", "Não identifiquei uma fala na gravação. Tente falar mais perto do microfone.");
    }
    if (result.text.length > MAX_MESSAGE) throw new ApiError(422, "TRANSCRIPT_TOO_LONG", "A gravação ficou longa. Envie uma fala mais curta.");
    return json({ text: result.text.trim() });
  });

  return { chat, speech, transcribe, status: async () => json(getStatus(options.config())) };
}

