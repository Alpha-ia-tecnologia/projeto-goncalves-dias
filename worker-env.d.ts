export {};
declare global {
  namespace Cloudflare {
    interface Env {
      DB?: D1Database;
      DEEPSEEK_API_KEY?: string;
      OPENAI_API_KEY?: string;
      DEEPSEEK_MODEL?: string;
      OPENAI_TTS_MODEL?: string;
      OPENAI_TTS_VOICE?: string;
      TRUST_PROXY_HEADERS?: string;
    }
  }
}