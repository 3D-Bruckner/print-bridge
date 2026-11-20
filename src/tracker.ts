// The print-bridge's minute (design "What it does"): approved quotes wait, a print that starts belongs to its quote (im Druck), a print
// that ends writes its time and grams to the quote and, with its last part, makes the invoice draft (fertig); a failed one puts the quote
// back to waiting. Every step is written down before the next (src/db), so a failure in the middle is picked up the next minute without
// writing anything twice. Without its tokens it does nothing (design P8).
import { configured } from "./config.ts";
import { readPrinter, type PrinterState } from "./homeassistant.ts";
import { addQuoteNote, approvedQuotes, invoiceFor, quoteByNumber, setDruckstatus, type Quote } from "./invoiceninja.ts";
import type { PrintRow } from "./db/store.ts";
import { push } from "./push.ts";
import type { Runtime } from "./runtime.ts";

const ACTIVE = new Set(["running", "prepare", "pause", "slicing", "init"]);
const INITIALIZED = "initialized";

const toldUnconfigured = new WeakSet<object>();

/** One minute's work; errors are logged, never thrown (the next minute tries again). */
export async function tick(rt: Runtime): Promise<void> {
  if (!configured(rt.config)) {
    if (!toldUnconfigured.has(rt.store)) {
      toldUnconfigured.add(rt.store);
      rt.log.warn("print-bridge: PRINT_HA_TOKEN or PRINT_INVOICENINJA_TOKEN is missing, so it waits");
    }
    return;
  }
  try {
    const waiting = await markWaiting(rt);
    const printer = await readPrinter(rt);
    if (!rt.store.getState(INITIALIZED)) {
      // The first start: what the printer reports now happened before the bridge was there (design P5).
      if (printer?.start)
        rt.store.insertPrint({ start: printer.start, task: printer.task, quote_id: null, quote_number: null, part: null, parts: null, state: "seen" }, now(rt));
      rt.store.setState(INITIALIZED, now(rt));
      rt.log.info({ printer: printer?.status ?? "off" }, "print-bridge: first start, the printer's current print is left alone");
      return;
    }
    if (!printer?.start) return;
    await follow(rt, printer, waiting);
  } catch (e) {
    rt.log.warn({ error: e instanceof Error ? e.message : String(e) }, "print-bridge: this minute failed; the next one tries again");
  }
}

const now = (rt: Runtime) => rt.clock().toISOString();

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

/** "… (2/3)" at the end of a task name: part 2 of 3. */
function partOf(task: string): { part: number; parts: number } | null {
  const m = task.match(/\((\d+)\s*\/\s*(\d+)\)\s*$/);
  if (!m) return null;
  const part = Number(m[1]);
  const parts = Number(m[2]);
  return part >= 1 && parts >= part ? { part, parts } : null;
}

async function follow(rt: Runtime, p: PrinterState, waiting: Quote[]): Promise<void> {
  let row = rt.store.print(p.start!);
  if (!row) row = await begin(rt, p, waiting);
  if (row.state !== "running" || !row.quote_id) return;
  if (p.status === "finish") return finish(rt, row, p);
  if (p.status === "failed") return fail(rt, row);
}

/** A print not seen before: its quote by number, else the only waiting one (design P4); im Druck. */
async function begin(rt: Runtime, p: PrinterState, waiting: Quote[]): Promise<PrintRow> {
  const number = p.task.match(rt.config.quotePattern)?.[0];
  let quote = number ? await quoteByNumber(rt, number) : null;
  let assumed = false;
  if (!quote && !number && waiting.length === 1) {
    quote = waiting[0]!;
    assumed = true;
  }
  const parts = partOf(p.task);
  const row = {
    start: p.start!,
    task: p.task,
    quote_id: quote?.id ?? null,
    quote_number: quote?.number ?? null,
    part: parts?.part ?? null,
    parts: parts?.parts ?? null,
  };
  if (!quote) {
    rt.store.insertPrint({ ...row, state: "unmatched" }, now(rt));
    const list = waiting.map((q) => q.number).join(", ");
    const which = number ? `die Nummer ${number} gibt es nicht` : waiting.length === 0 ? "es wartet keins" : `es warten ${waiting.length} (${list})`;
    await push(rt, {
      title: "Druck ohne Angebot",
      message: `„${p.task}“ gehört zu keinem Angebot: ${which}. Diesen Druck in Invoice Ninja von Hand eintragen; beim nächsten die Angebotsnummer in den Namen setzen (z. B. „${waiting[0]?.number ?? "3D-2026-0010"} Vase“).`,
    });
    rt.log.warn({ task: p.task }, "print-bridge: a print without a quote");
    return rt.store.print(p.start!)!;
  }
  rt.store.insertPrint({ ...row, state: "running" }, now(rt));
  if (ACTIVE.has(p.status) || p.status === "finish") await setDruckstatus(rt, "quotes", quote.id, "im Druck");
  rt.log.info({ quote: quote.number, assumed }, "print-bridge: a print started");
  if (assumed)
    await push(rt, {
      title: `Druck zugeordnet: ${quote.number}`,
      message: `„${p.task}“ hat keine Angebotsnummer im Namen; es wartet nur ${quote.number}, also gehört der Druck dazu.`,
    });
  return rt.store.print(p.start!)!;
}

function duration(start: string, end: string | null): string | null {
  if (!end) return null;
  const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
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
    await addQuoteNote(rt, row.quote_id!, `Gedruckt am ${day}: ${row.task}${what ? `, ${what}` : ""}`);
    rt.store.updatePrint(row.start, { note_written: 1 }, now(rt));
  }
  const last = !row.parts || rt.store.partsDone(row.quote_id!) + 1 >= row.parts;
  if (!last) {
    await setDruckstatus(rt, "quotes", row.quote_id!, "im Druck");
    rt.store.updatePrint(row.start, { state: "done" }, now(rt));
    await push(rt, { title: `Teil ${row.part}/${row.parts} fertig: ${row.quote_number}`, message: `„${row.task}“ ist gedruckt${what ? ` (${what})` : ""}.` });
    return;
  }
  await setDruckstatus(rt, "quotes", row.quote_id!, "fertig");
  const invoice = await invoiceFor(rt, row.quote_id!);
  await setDruckstatus(rt, "invoices", invoice.id, "fertig");
  rt.store.updatePrint(row.start, { state: "done" }, now(rt));
  rt.log.info({ quote: row.quote_number, invoice: invoice.number }, "print-bridge: printed, invoice draft made");
  await push(rt, {
    title: `Fertig: ${row.quote_number}`,
    message: `Gedruckt${what ? ` (${what})` : ""}. Rechnungsentwurf ${invoice.number} ist angelegt: prüfen und senden.`,
  });
}

async function fail(rt: Runtime, row: PrintRow): Promise<void> {
  await setDruckstatus(rt, "quotes", row.quote_id!, "wartet");
  rt.store.updatePrint(row.start, { state: "failed" }, now(rt));
  rt.log.warn({ quote: row.quote_number }, "print-bridge: a print failed");
  await push(rt, {
    title: `Druck fehlgeschlagen: ${row.quote_number}`,
    message: `„${row.task}“ ist abgebrochen; ${row.quote_number} wartet wieder auf seinen Druck.`,
  });
}
