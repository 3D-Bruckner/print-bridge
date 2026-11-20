// The A1 as Home Assistant's bambu_lab integration reports it (design P2): one POST /api/template a minute returns the print's status,
// task name, weight, start and end. bambu_lab names its entities in Home Assistant's language; these are the German ones
// (sensor.<printer>_druckstatus …), as Marcel's Home Assistant has them.
import type { Runtime } from "./runtime.ts";
import { call } from "./serviceerror.ts";

export type PrinterState = { status: string; task: string; grams: number | null; start: string | null; end: string | null };

const ENTITIES = { status: "druckstatus", task: "name_der_aufgabe", grams: "gewicht_des_drucks", start: "startzeit", end: "endzeit" } as const;

const known = (v: string | undefined): string | null => (v && !["unknown", "unavailable", "none", ""].includes(v.toLowerCase()) ? v : null);

/** The printer now; null while Home Assistant doesn't know (the printer is off). */
export async function readPrinter(rt: Runtime): Promise<PrinterState | null> {
  const p = `sensor.${rt.config.ha.printer}_`;
  const template = `{{ {${Object.entries(ENTITIES)
    .map(([k, e]) => `"${k}": states("${p}${e}")`)
    .join(", ")}} | tojson }}`;
  const r = await call(rt, "homeassistant", `${rt.config.ha.url}/api/template`, {
    method: "POST",
    headers: { authorization: `Bearer ${rt.config.ha.token}`, "content-type": "application/json" },
    body: JSON.stringify({ template }),
    timeoutMs: 15_000,
  });
  const s = JSON.parse(await r.text()) as Record<keyof typeof ENTITIES, string>;
  const status = known(s.status);
  if (!status) return null;
  const grams = known(s.grams);
  return {
    status,
    task: known(s.task) ?? "",
    grams: grams === null || Number.isNaN(Number(grams)) ? null : Number(grams),
    start: known(s.start),
    end: known(s.end),
  };
}
