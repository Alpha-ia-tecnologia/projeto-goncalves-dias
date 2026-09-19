import { env } from "cloudflare:workers";
import { createApiHandlers, readConfig } from "./api";

// Cloudflare secrets and local .env.local bindings remain in the server bundle.
// Never import this module into a client component.
export const api = createApiHandlers({
  config: () => readConfig(env as Record<string, unknown>),
});
