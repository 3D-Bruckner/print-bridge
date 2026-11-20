// The A1's prints as Bambuddy archives them (design P2, changed 2026-11-21: Bambuddy instead of Home Assistant): one entry per print,
// with its own id, its name, its status (printing, then completed, failed or cancelled), when it started and ended, how long it really
// took and the filament it used. Read with a Bambuddy API key that may only read (X-API-Key).
import type { Runtime } from "./runtime.ts";
import { call } from "./serviceerror.ts";

export type Print = {
  id: string;
  name: string;
  status: "printing" | "completed" | "failed" | "other";
  startedAt: string | null;
  completedAt: string | null;
  seconds: number | null;
  grams: number | null;
};

type Raw = {
  id: number;
  print_name?: string | null;
  filename?: string;
  status?: string;
  started_at?: string | null;
  completed_at?: string | null;
  actual_time_seconds?: number | null;
  filament_used_grams?: number | null;
};

const STATUS: Record<string, Print["status"]> = { printing: "printing", completed: "completed", failed: "failed", cancelled: "failed" };

/** The newest archived prints, oldest first. */
export async function recentPrints(rt: Runtime, limit = 20): Promise<Print[]> {
  const r = await call(rt, "bambuddy", `${rt.config.bambuddy.url}/api/v1/archives/?limit=${limit}`, {
    headers: { "X-API-Key": rt.config.bambuddy.key ?? "", accept: "application/json" },
    timeoutMs: 15_000,
  });
  let raw: Raw[];
  try {
    raw = (await r.json()) as Raw[];
  } catch {
    throw new Error("bambuddy sent an answer that isn't JSON");
  }
  return raw
    .map((a) => ({
      id: String(a.id),
      name: (a.print_name || a.filename || "").trim(),
      status: STATUS[a.status ?? ""] ?? "other",
      startedAt: a.started_at ?? null,
      completedAt: a.completed_at ?? null,
      seconds: typeof a.actual_time_seconds === "number" ? a.actual_time_seconds : null,
      grams: typeof a.filament_used_grams === "number" ? a.filament_used_grams : null,
    }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}
