// GET /health and nothing else: the bridge only connects out. It says whether the database answers and whether the bridge has its
// tokens (it waits without them, design P8).
import { configured } from "./config.ts";
import type { Runtime } from "./runtime.ts";

export function handle(rt: Runtime, method: string, path: string): { status: number; body: unknown } {
  if (method === "GET" && path === "/health") {
    if (!rt.store.answers()) return { status: 503, body: { status: "unavailable" } };
    return { status: 200, body: { status: "ok", configured: configured(rt.config) } };
  }
  return { status: 404, body: null };
}
