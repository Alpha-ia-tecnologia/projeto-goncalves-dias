import { defineConfig } from "vitest/config";

// Pure request handlers run without the Cloudflare/Vinext build plugins.
export default defineConfig({ test: { include: ["tests/server*.test.ts"], environment: "node" } });
