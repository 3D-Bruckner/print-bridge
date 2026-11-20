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
  // `exists`: whether Home Assistant has the printer at all; a wrong PRINT_HA_PRINTER would otherwise look like a printer that is off.
  const template = `{{ {"exists": states.sensor.${rt.config.ha.printer}_${ENTITIES.status} is not none, ${Object.entries(ENTITIES)
    .map(([k, e]) => `"${k}": states("${p}${e}")`)
    .join(", ")}} | tojson }}`;
  const r = await call(rt, "homeassistant", `${rt.config.ha.url}/api/template`, {
    method: "POST",
    headers: { authorization: `Bearer ${rt.config.ha.token}`, "content-type": "application/json" },
    body: JSON.stringify({ template }),
    timeoutMs: 15_000,
  });
  let s: Record<keyof typeof ENTITIES, string> & { exists?: boolean };
  try {
    s = JSON.parse(await r.text()) as typeof s;
  } catch {
    throw new Error("homeassistant sent an answer that isn't JSON");
  }
  if (s.exists === false) throw new Error(`homeassistant has no printer ${rt.config.ha.printer} (PRINT_HA_PRINTER)`);
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
