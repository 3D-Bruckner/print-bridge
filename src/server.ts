// The bridge's HTTP contract. Caddy publishes GET/HEAD of /status.json, /live.jpg and /colors.json to everyone, and /costs and /control only
// with their own tokens; /health stays on the private network. Purchase costs are behind /costs alone and are in no public answer.
import { createHash, timingSafeEqual } from "node:crypto";
import { configured } from "./config.ts";
import { keptColors, keptCosts } from "./inventory.ts";
import { currentLive, setHidden, type Live } from "./live.ts";
import type { Runtime } from "./runtime.ts";
import { lastOk } from "./tracker.ts";

const ORIGIN = "https://3dbruckner.de";
export const MAX_BODY_BYTES = 4096;
const STALE_AFTER_MS = { orders: 30 * 60_000, live: 5 * 60_000, inventory: 30 * 60_000 };

export type Jobs = { startedAt: number; live: number | null; inventory: number | null };
export type Request = { method: string; path: string; header: (name: string) => string | undefined; body: Buffer };
export type Answer = { status: number; headers: Record<string, string>; body: Buffer | string | null };

const plain = (status: number, text: string, extra: Record<string, string> = {}): Answer => ({
  status,
  headers: { ...extra, "Cache-Control": "no-store", "Content-Type": "text/plain" },
  body: `${text}\n`,
});
const json = (body: unknown, cache: string, extra: Record<string, string> = {}): Answer => ({
  status: 200,
  headers: { ...extra, "Content-Type": "application/json", "Cache-Control": cache },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const digest = (v: string) => createHash("sha256").update(v).digest();
function bearer(header: string | undefined, token: string | null): boolean {
  if (!token || !header?.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(header.slice("Bearer ".length)), digest(token));
}

function page(hidden: boolean): string {
  const [title, text, value, button] = hidden
    ? ["Verborgen", "Dieser Druck erscheint nicht auf 3dbruckner.de. Nach dem Druck wird wieder alles öffentlich.", "0", "Wieder öffentlich machen"]
    : ["Öffentlich", "Laufende Drucke erscheinen live auf 3dbruckner.de.", "1", "Diesen Druck verbergen"];
  return `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>3D-Drucker live</title><style>:root{color-scheme:light dark}body{font:17px system-ui;max-width:26rem;margin:15vh auto;padding:0 1.25rem}h1{font-size:2rem;margin:.2rem 0}small{opacity:.7}button{font:inherit;width:100%;padding:.9rem;margin-top:1rem;cursor:pointer}</style>
<small>3D-Drucker live</small><h1>${title}</h1><p>${text}</p><form method="post" action="/visibility"><input type="hidden" name="hidden" value="${value}"><button>${button}</button></form></html>`;
}

/** Which jobs have had no success for too long. A job counts from the bridge's start until its first success. */
export function staleJobs(rt: Runtime, jobs: Jobs): string[] {
  if (!configured(rt.config)) return [];
  const now = rt.clock().getTime();
  const orders = lastOk(rt);
  const last = { orders: orders ? Date.parse(orders) : null, live: jobs.live, inventory: jobs.inventory };
  return (Object.keys(STALE_AFTER_MS) as (keyof typeof STALE_AFTER_MS)[]).filter((k) => now - (last[k] ?? jobs.startedAt) > STALE_AFTER_MS[k]);
}

function route(rt: Runtime, live: Live, jobs: Jobs, r: Request): Answer {
  const { method, path } = r;
  if (method === "POST" && path === "/control/visibility") {
    if (!bearer(r.header("authorization"), rt.config.controlToken) || r.header("sec-fetch-site") !== "same-origin") return plain(403, "forbidden");
    const values = new URLSearchParams(r.body.toString()).getAll("hidden");
    if (values.length !== 1 || (values[0] !== "0" && values[0] !== "1")) return plain(400, "bad value");
    setHidden(rt, live, values[0] === "1");
    return { status: 303, headers: { "Cache-Control": "no-store", Location: "/" }, body: null };
  }
  if (method !== "GET" && method !== "HEAD") return plain(404, "not found");
  if (path === "/health") {
    if (!rt.store.answers()) return { status: 503, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "unavailable" }) };
    const stale = staleJobs(rt, jobs);
    return json({ status: "ok", configured: configured(rt.config), lastOk: lastOk(rt), stale }, "no-store");
  }
  if (path === "/control") {
    if (!bearer(r.header("authorization"), rt.config.controlToken)) return plain(403, "forbidden");
    return { status: 200, headers: { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8" }, body: page(live.hidden) };
  }
  if (path === "/costs") {
    if (!bearer(r.header("authorization"), rt.config.costsToken)) return plain(401, "unauthorized");
    const costs = keptCosts(rt);
    return costs ? json(costs, "no-store") : plain(503, "no costs yet");
  }
  if (path === "/colors.json") {
    const colors = keptColors(rt);
    return colors ? json(colors, "public, max-age=60") : plain(404, "no list yet");
  }
  const cors = { "Access-Control-Allow-Origin": ORIGIN };
  const current = currentLive(live, rt.clock().getTime());
  if (path === "/status.json") return json(current.status, "public, max-age=1", cors);
  if (path === "/live.jpg") {
    if (!current.picture) return plain(404, "no picture", cors);
    return { status: 200, headers: { ...cors, "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=60, s-maxage=60" }, body: current.picture };
  }
  return plain(404, "not found");
}

/** The whole contract; HEAD gets GET's headers and no body. */
export function handle(rt: Runtime, live: Live, jobs: Jobs, r: Request): Answer {
  const a = route(rt, live, jobs, r);
  const length = a.body === null ? 0 : Buffer.byteLength(a.body);
  return { ...a, headers: { ...a.headers, "Content-Length": String(length) }, body: r.method === "HEAD" ? null : a.body };
}
