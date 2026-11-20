// The print-bridge's minute (design "What it does"): approved quotes wait; a print that starts belongs to its quote (im Druck); a print
// that ends writes its time and grams to the quote and, with its last part, makes the invoice draft (fertig); a failed one puts the quote
// back to waiting. Every step is written down before the next (src/db), so a failure in the middle is picked up the next minute without
// writing anything twice. Without its tokens it does nothing (design P8).
//
// Converting is the one step that is hard to undo, so it happens only when everything is certain (review of 2026-11-20): the print was
// seen starting, or began after the bridge first saw the printer; its name carries the number of an approved quote (a print matched as
// "the only waiting quote" is noted, never converted); and the quote isn't converted already (a reprint is noted and nothing else).
import { configured } from "./config.ts";
import { readPrinter, type PrinterState } from "./homeassistant.ts";
import { addQuoteNote, APPROVED, approvedQuotes, CONVERTED, getQuote, invoiceFor, quoteByNumber, setDruckstatus, type Quote } from "./invoiceninja.ts";
import type { PrintRow } from "./db/store.ts";
import { push } from "./push.ts";
import type { Runtime } from "./runtime.ts";

const ACTIVE = new Set(["running", "prepare", "pause", "slicing", "init"]);
const ENDED = new Set(["finish", "failed"]);
/** The time the bridge first saw the printer on: an ended print that began before it is history, not work. */
const SINCE = "since";
/** After this many failed minutes in a row, one push (review I4). */
const STUCK_AFTER = 30;

const toldUnconfigured = new WeakSet<object>();
const health = new WeakMap<object, { failures: number; told: boolean; lastOk: string | null }>();

/** Health as /health shows it: the last minute that worked. */
export const lastOk = (rt: Runtime): string | null => health.get(rt.store)?.lastOk ?? null;

/** One minute's work; errors are logged, never thrown (the next minute tries again), and pushed once after half an hour. */
export async function tick(rt: Runtime): Promise<void> {
  if (!configured(rt.config)) {
    if (!toldUnconfigured.has(rt.store)) {
      toldUnconfigured.add(rt.store);
      rt.log.warn("print-bridge: PRINT_HA_TOKEN or PRINT_INVOICENINJA_TOKEN is missing, so it waits");
    }
    return;
  }
  const h = health.get(rt.store) ?? { failures: 0, told: false, lastOk: null };
  health.set(rt.store, h);
  try {
    await minute(rt);
    h.failures = 0;
    h.told = false;
    h.lastOk = now(rt);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    h.failures++;
    rt.log.warn({ error, failures: h.failures }, "print-bridge: this minute failed; the next one tries again");
    if (h.failures >= STUCK_AFTER && !h.told) {
      h.told = true;
      await push(rt, { title: "print-bridge hängt", message: `Seit ${STUCK_AFTER} Minuten klappt nichts: ${error}. Ein Token falsch oder ein Dienst aus?` });
    }
  }
}

const now = (rt: Runtime) => rt.clock().toISOString();

/** A start time as an instant to the minute, so another spelling of the same time is the same print (review C1). */
function startKey(start: string): string {
  const t = Date.parse(start);
  return Number.isNaN(t) ? start : new Date(Math.floor(t / 60_000) * 60_000).toISOString();
}

async function minute(rt: Runtime): Promise<void> {
  const waiting = await markWaiting(rt);
  const printer = await readPrinter(rt);
  if (!printer) return; // off: nothing to learn, and the first start waits for the printer to be on (review C1)
  if (!rt.store.getState(SINCE)) {
    // The first time the bridge sees the printer on: what it reports now happened before the bridge was there (design P5).
    if (printer.start)
      rt.store.insertPrint({ start: startKey(printer.start), task: "", quote_id: null, quote_number: null, part: null, parts: null, state: "seen" }, now(rt));
    rt.store.setState(SINCE, now(rt));
    rt.log.info({ printer: printer.status }, "print-bridge: first sight of the printer; its current print is left alone");
    return;
  }
  if (!printer.start) return;
  await follow(rt, printer, waiting);
}

/** Approved quotes without a Druckstatus get "wartet"; the quotes waiting now. */
async function markWaiting(rt: Runtime): Promise<Quote[]> {
  const approved = await approvedQuotes(rt);
  for (const q of approved.filter((x) => !x.druckstatus)) {
    await setDruckstatus(rt, "quotes", q.id, "wartet");
    q.druckstatus = "wartet";
    rt.log.info({ quote: q.number }, "print-bridge: quote approved, waits for its print");
  }
  return approved.filter((q) => q.druckstatus === "wartet");
}

/** "… (2/3)" at the end of a task name: part 2 of 3; "bad" for a suffix that looks like one but isn't (review minor). */
function partOf(task: string): { part: number; parts: number } | "bad" | null {
  const m = task.match(/\((\d+)\s*\/\s*(\d+)\)\s*$/);
  if (!m) return null;
  const part = Number(m[1]);
  const parts = Number(m[2]);
  return part >= 1 && parts >= part ? { part, parts } : "bad";
}

async function follow(rt: Runtime, p: PrinterState, waiting: Quote[]): Promise<void> {
  const key = startKey(p.start!);
  let row = rt.store.print(key);
  if (!row) {
    // A print not seen before is work only while it runs, or when it ended after the bridge first saw the printer: an old "finish"
    // still shown after a night switched off is history (review C1).
    const since = Date.parse(rt.store.getState(SINCE)!);
    const fresh = ACTIVE.has(p.status) || (ENDED.has(p.status) && Date.parse(key) >= since - 60_000);
    if (!fresh) {
      rt.store.insertPrint({ start: key, task: "", quote_id: null, quote_number: null, part: null, parts: null, state: "seen" }, now(rt));
      return;
    }
    row = await begin(rt, key, p, waiting);
  }
  if (row.state !== "running" || !row.quote_id) return;
  if (p.status === "finish") return finish(rt, row, p);
  if (p.status === "failed") return fail(rt, row);
}

async function unmatched(rt: Runtime, row: Omit<PrintRow, "state" | "note_written" | "assumed" | "updated_at">, message: string): Promise<PrintRow> {
  rt.store.insertPrint({ ...row, quote_id: null, quote_number: null, state: "unmatched" }, now(rt));
  await push(rt, { title: "Druck ohne Angebot", message });
  rt.log.warn("print-bridge: a print without a quote");
  return rt.store.print(row.start)!;
}

/** A print not seen before: its approved quote by number, else (noted only, never converted) the only waiting one (design P4). */
async function begin(rt: Runtime, key: string, p: PrinterState, waiting: Quote[]): Promise<PrintRow> {
  const number = p.task.match(rt.config.quotePattern)?.[0];
  const parts = partOf(p.task);
  const row = {
    start: key,
    task: p.task,
    quote_id: null as string | null,
    quote_number: null as string | null,
    part: null as number | null,
    parts: null as number | null,
  };
  if (parts === "bad") return unmatched(rt, row, "Ein Druck hat einen Teil-Zusatz, der nicht passt (z. B. „(3/2)“); nichts eingetragen.");
  if (parts) Object.assign(row, parts);
  let quote: Quote | null;
  let assumed = false;
  if (number) {
    quote = await quoteByNumber(rt, number);
    if (!quote) return unmatched(rt, row, `Der Druck nennt ${number}, aber dieses Angebot gibt es nicht; nichts eingetragen.`);
    if (quote.statusId !== APPROVED && quote.statusId !== CONVERTED)
      return unmatched(rt, row, `Der Druck nennt ${number}, aber das Angebot ist noch nicht angenommen; nichts eingetragen.`);
  } else if (p.task.trim() && waiting.length === 1) {
    quote = waiting[0]!;
    assumed = true;
  } else {
    const which = waiting.length === 0 ? "kein Angebot wartet" : `es warten ${waiting.length} Angebote (${waiting.map((q) => q.number).join(", ")})`;
    return unmatched(
      rt,
      row,
      `Ein Druck ohne Angebotsnummer im Namen läuft, und ${which}. Ihn in Invoice Ninja von Hand eintragen; beim nächsten die Nummer in den Namen setzen (z. B. „${waiting[0]?.number ?? "3D-2026-0010"} Vase“).`,
    );
  }
  rt.store.insertPrint({ ...row, quote_id: quote.id, quote_number: quote.number, state: "running", assumed: assumed ? 1 : 0 }, now(rt));
  if (quote.statusId === APPROVED) await setDruckstatus(rt, "quotes", quote.id, "im Druck");
  rt.log.info({ quote: quote.number, assumed }, "print-bridge: a print started");
  if (assumed)
    await push(rt, {
      title: `Druck zugeordnet: ${quote.number}`,
      message: `Ein Druck ohne Angebotsnummer im Namen läuft; es wartet nur ${quote.number}, also ist er dort eingetragen.`,
    });
  return rt.store.print(key)!;
}

function duration(start: string, end: string | null): string | null {
  if (!end) return null;
  const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

const de = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 1 });

async function finish(rt: Runtime, row: PrintRow, p: PrinterState): Promise<void> {
  const took = duration(row.start, p.end);
  const what = [took, p.grams !== null ? `${de(p.grams)} g` : null].filter(Boolean).join(", ");
  if (!row.note_written) {
    const day = new Date(p.end ?? row.start).toLocaleDateString("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: process.env.TZ || "Europe/Berlin",
    });
    const part = row.parts ? ` (Teil ${row.part}/${row.parts})` : "";
    await addQuoteNote(rt, row.quote_id!, `Gedruckt am ${day}${part}${what ? `: ${what}` : ""}`);
    rt.store.updatePrint(row.start, { note_written: 1 }, now(rt));
  }
  const quote = await getQuote(rt, row.quote_id!);
  const done = (title: string, message: string) => {
    rt.store.updatePrint(row.start, { state: "done" }, now(rt));
    return push(rt, { title, message });
  };
  // A reprint of a quote that is an invoice already: noted, nothing else (review I1).
  if (quote.statusId === CONVERTED) {
    const invoice = await invoiceFor(rt, quote.id);
    return done(
      `Nachdruck: ${row.quote_number}`,
      `Gedruckt${what ? ` (${what})` : ""} und notiert; die Rechnung ${invoice.number} gibt es schon, an ihr ändert sich nichts.`,
    );
  }
  if (quote.statusId !== APPROVED)
    return done(
      `Gedruckt: ${row.quote_number}`,
      `Gedruckt${what ? ` (${what})` : ""} und notiert; das Angebot ist nicht mehr angenommen, also keine Rechnung.`,
    );
  if (row.assumed)
    return done(
      `Gedruckt, bitte prüfen: ${row.quote_number}`,
      `Der Druck ohne Nummer ist fertig${what ? ` (${what})` : ""} und bei ${row.quote_number} eingetragen. Gehört er dazu, das Angebot in Invoice Ninja von Hand in eine Rechnung umwandeln.`,
    );
  if (row.parts && !lastPart(rt, row)) {
    await setDruckstatus(rt, "quotes", row.quote_id!, "im Druck");
    return done(`Teil ${row.part}/${row.parts} fertig: ${row.quote_number}`, `Gedruckt${what ? ` (${what})` : ""}.`);
  }
  await setDruckstatus(rt, "quotes", row.quote_id!, "fertig");
  const invoice = await invoiceFor(rt, row.quote_id!);
  await setDruckstatus(rt, "invoices", invoice.id, "fertig");
  rt.log.info({ quote: row.quote_number, invoice: invoice.number }, "print-bridge: printed, invoice draft made");
  return done(`Fertig: ${row.quote_number}`, `Gedruckt${what ? ` (${what})` : ""}. Rechnungsentwurf ${invoice.number} ist angelegt: prüfen und senden.`);
}

/** Whether this part completes the quote: every part 1..parts done, this one included, each counted once (review I2). */
function lastPart(rt: Runtime, row: PrintRow): boolean {
  const others = rt.store.partsDone(row.quote_id!); // done rows' distinct parts, without this row (still "running")
  const thisIsNew = !rt.store.partDone(row.quote_id!, row.part!);
  return others + (thisIsNew ? 1 : 0) >= row.parts!;
}

async function fail(rt: Runtime, row: PrintRow): Promise<void> {
  const quote = await getQuote(rt, row.quote_id!);
  if (quote.statusId === APPROVED) await setDruckstatus(rt, "quotes", row.quote_id!, "wartet");
  rt.store.updatePrint(row.start, { state: "failed" }, now(rt));
  rt.log.warn({ quote: row.quote_number }, "print-bridge: a print failed");
  await push(rt, {
    title: `Druck fehlgeschlagen: ${row.quote_number}`,
    message: `Der Druck zu ${row.quote_number} ist abgebrochen; das Angebot wartet wieder auf seinen Druck.`,
  });
}
