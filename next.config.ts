import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Node build (DEPLOY_TARGET=node) ships as dist/standalone/server.js with
  // only its runtime dependencies. The Cloudflare build stays a Worker.
  output: process.env.DEPLOY_TARGET === "node" ? "standalone" : undefined,
};

export default nextConfig;
