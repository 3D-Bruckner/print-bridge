// The spools in Bambuddy's inventory, read every five minutes, become two lists kept in the database, so they stay while Bambuddy is away:
// the public colours for 3dbruckner.de (colour, material, finish and swatch; never a brand, weight, price or note), and the average
// purchase cost per kilogram for the portfolio's signed-in form. It shares nothing with the minute in tracker.ts, so a failure here never
// holds up an order.
import type { Runtime } from "./runtime.ts";
import { call } from "./serviceerror.ts";

export const INVENTORY_EVERY_MS = 5 * 60_000;
const MAX_COLORS = 200;
const MAX_TEXT = 64;
const COLORS = "colors";
const COSTS = "costs";
const MATERIALS = ["PLA", "PETG"] as const;

export type PublicColor = { name: string; material: string; finish: string | null; rgba: string };
export type Costs = Partial<Record<(typeof MATERIALS)[number], number>>;
type RawSpool = { material?: unknown; subtype?: unknown; color_name?: unknown; rgba?: unknown; cost_per_kg?: unknown; archived_at?: unknown };

const text = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= MAX_TEXT && /^[\p{L}\p{N}\p{P}\p{S} ]+$/u.test(t) ? t : null;
};

/** The public list: one entry per colour, material and finish, in a stable order so an unchanged inventory gives the same list. */
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

/** What a kilogram of each material costs, on average over the spools in stock that have a price. */
export function averageCosts(spools: RawSpool[]): Costs {
  const costs: Costs = {};
  for (const material of MATERIALS) {
    const prices = spools.filter((s) => !s.archived_at && s.material === material && typeof s.cost_per_kg === "number").map((s) => s.cost_per_kg as number);
    if (prices.length) costs[material] = Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100;
  }
  return costs;
}

/** The colour list as the site's build reads it, or null before the first one. */
export const keptColors = (rt: Runtime): string | null => rt.store.getState(COLORS) ?? null;
/** The costs as the portfolio reads them, or null before the first read. */
export const keptCosts = (rt: Runtime): string | null => rt.store.getState(COSTS) ?? null;
/** Keeps a colour list from the old receiver, unless the bridge has one already. */
export function adoptColors(rt: Runtime, colors: PublicColor[]): void {
  if (!keptColors(rt) && colors.length) rt.store.setState(COLORS, JSON.stringify({ version: 1, colors }));
}

/** Reads the inventory and keeps both lists; true when it worked. An empty list leaves the last one. Errors are logged. */
export async function refreshInventory(rt: Runtime): Promise<boolean> {
  if (!rt.config.bambuddy.key) return false;
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
    if (colors.length) rt.store.setState(COLORS, JSON.stringify({ version: 1, colors }));
    else rt.log.warn("print-bridge: no colours in the inventory, so the last list stays");
    const costs = averageCosts(raw as RawSpool[]);
    if (Object.keys(costs).length) rt.store.setState(COSTS, JSON.stringify({ version: 1, costs }));
    return true;
  } catch (e) {
    rt.log.warn({ error: e instanceof Error ? e.message : String(e) }, "print-bridge: the inventory wasn't read; the next round tries again");
    return false;
  }
}
