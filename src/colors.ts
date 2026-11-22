// The filament colours for 3dbruckner.de's materials page: every five minutes the spools in Bambuddy's inventory become a public list
// (colour, material, finish and the swatch colour; never a brand, weight, price or note) that goes to gewerbe-1, where the site's build
// reads it. It runs beside the minute in tracker.ts and shares nothing with it, so a failure here never holds up an order.
import type { Runtime } from "./runtime.ts";
import { call } from "./serviceerror.ts";

export const COLORS_EVERY_MS = 5 * 60_000;
const MAX_COLORS = 200;
const MAX_TEXT = 64;

export type PublicColor = { name: string; material: string; finish: string | null; rgba: string };

type RawSpool = { material?: unknown; subtype?: unknown; color_name?: unknown; rgba?: unknown; archived_at?: unknown };

const text = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= MAX_TEXT && /^[\p{L}\p{N}\p{P}\p{S} ]+$/u.test(t) ? t : null;
};

/** The public list: one entry per colour, material and finish, in a stable order so an unchanged inventory sends the same list. */
export function publicColors(spools: RawSpool[]): PublicColor[] {
  const out = new Map<string, PublicColor>();
  for (const s of spools) {
    if (s.archived_at) continue;
    const name = text(s.color_name);
    const material = text(s.material);
    const rgba = typeof s.rgba === "string" && /^[0-9a-f]{8}$/i.test(s.rgba) ? s.rgba.toUpperCase() : null;
    if (!name || !material || !rgba) continue;
    const finish = text(s.subtype);
    const key = JSON.stringify([material, finish, name]);
    if (!out.has(key)) out.set(key, { name, material, finish, rgba });
  }
  const order = (c: PublicColor) => `${c.material}\u0000${c.finish ?? ""}\u0000${c.name}`;
  return [...out.values()].sort((a, b) => (order(a) < order(b) ? -1 : 1)).slice(0, MAX_COLORS);
}

/** Reads the inventory and sends the list. An empty inventory sends nothing, so gewerbe-1 keeps the last list. Errors are logged. */
export async function syncColors(rt: Runtime): Promise<void> {
  const { url, token } = rt.config.colors;
  if (!url || !token || !rt.config.bambuddy.key) return;
  try {
    const r = await call(rt, "bambuddy", `${rt.config.bambuddy.url}/api/v1/inventory/spools`, {
      headers: { "X-API-Key": rt.config.bambuddy.key, accept: "application/json" },
      timeoutMs: 15_000,
    });
    let raw: unknown;
    try {
      raw = await r.json();
    } catch {
      throw new Error("bambuddy sent an answer that isn't JSON");
    }
    if (!Array.isArray(raw)) throw new Error("bambuddy's inventory isn't a list");
    const colors = publicColors(raw as RawSpool[]);
    if (!colors.length) {
      rt.log.warn("print-bridge: no colours in the inventory, so the last list stays");
      return;
    }
    await call(rt, "colors", url, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: 1, colors }),
      timeoutMs: 15_000,
    });
  } catch (e) {
    rt.log.warn({ error: e instanceof Error ? e.message : String(e) }, "print-bridge: the colour list wasn't sent; the next round tries again");
  }
}
