// Stands in for `cloudflare:workers` in the Node build (DEPLOY_TARGET=node).
// A container host such as Easypanel hands its variables to the process, so the
// server reads them from process.env. Read on every request, never inlined.
export const env = process.env;
