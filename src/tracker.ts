// The print-bridge's minute (design "What it does"): approved quotes wait; a print that starts belongs to its quote (im Druck); a print
// that ends writes its time and grams to the quote and, with its last part, makes the invoice draft (fertig); a failed one puts the quote
// back to waiting. The prints are Bambuddy's archive (one entry per print, by its id); every step is written down before the next
// (src/db), so a failure in the middle is picked up the next minute without writing anything twice. Without its key and token it does
// nothing (design P8).
//
// Converting is the one step that is hard to undo, so it happens only when everything is certain (review of 2026-11-20, design P9): the
// print was seen running, or began after the bridge first looked; its name carries the number of an approved quote (a print matched as
// "the only waiting quote" is noted, never converted); every part is done; and the quote isn't converted already (a reprint is noted).
import { recentPrints, type Print } from "./bambuddy.ts";
import { configured } from "./config.ts";
import { addQuoteNote, APPROVED, approvedQuotes, CONVERTED, getQuote, invoiceFor, quoteByNumber, setDruckstatus, type Quote } from "./invoiceninja.ts";
import type { PrintRow } from "./db/store.ts";
import { push } from "./push.ts";
import type { Runtime } from "./runtime.ts";

/** When the bridge first looked at Bambuddy's archive: an ended print that began before it is history, not work. */
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
      rt.log.warn("print-bridge: PRINT_BAMBUDDY_KEY or PRINT_INVOICENINJA_TOKEN is missing, so it waits");
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
      await push(rt, {
        title: "print-bridge hängt",
        message: `Seit ${STUCK_AFTER} Minuten klappt nichts: ${error}. Ein Schlüssel falsch oder ein Dienst aus?`,
      });
    }
  }
}

const now = (rt: Runtime) => rt.clock().toISOString();

const seen = (rt: Runtime, id: string) =>
  rt.store.insertPrint({ start: id, task: "", quote_id: null, quote_number: null, part: null, parts: null, state: "seen" }, now(rt));

async function minute(rt: Runtime): Promise<void> {
  const waiting = await markWaiting(rt);
  const prints = await recentPrints(rt);
  if (!rt.store.getState(SINCE)) {
    // The first look: everything archived so far happened before the bridge was there (design P5).
    for (const p of prints) seen(rt, p.id);
    rt.store.setState(SINCE, now(rt));
    rt.log.info({ prints: prints.length }, "print-bridge: first look at the archive; what is there is left alone");
    return;
  }
  for (const p of prints) await follow(rt, p, waiting);
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

/** "… (2/3)" at the end of a print's name: part 2 of 3; "bad" for a suffix that looks like one but isn't. */
function partOf(name: string): { part: number; parts: number } | "bad" | null {
  const m = name.match(/\((\d+)\s*\/\s*(\d+)\)\s*$/);
  if (!m) return null;
  const part = Number(m[1]);
  const parts = Number(m[2]);
  return part >= 1 && parts >= part ? { part, parts } : "bad";
}

async function follow(rt: Runtime, p: Print, waiting: Quote[]): Promise<void> {
  let row = rt.store.print(p.id);
  if (!row) {
    // An archive entry not seen before is work while it prints, or when it ended after the bridge first looked; one that never
    // started (an uploaded file, not a print) or began before that is history (review C1).
    const since = Date.parse(rt.store.getState(SINCE)!);
    const began = p.startedAt ? Date.parse(p.startedAt) : NaN;
    const fresh = p.status === "printing" || ((p.status === "completed" || p.status === "failed") && began >= since - 60_000);
    if (!fresh) return seen(rt, p.id);
    row = await begin(rt, p, waiting);
  }
  if (row.state !== "running" || !row.quote_id) return;
  if (p.status === "completed") return finish(rt, row, p);
  if (p.status === "failed") return fail(rt, row);
}

async function unmatched(rt: Runtime, id: string, name: string, message: string): Promise<PrintRow> {
  rt.store.insertPrint({ start: id, task: name, quote_id: null, quote_number: null, part: null, parts: null, state: "unmatched" }, now(rt));
  await push(rt, { title: "Druck ohne Angebot", message });
  rt.log.warn({ print: id }, "print-bridge: a print without a quote");
  return rt.store.print(id)!;
}

/** A print not seen before: its approved quote by number, else (noted only, never converted) the only waiting one (design P4). */
async function begin(rt: Runtime, p: Print, waiting: Quote[]): Promise<PrintRow> {
  const number = p.name.match(rt.config.quotePattern)?.[0];
  const parts = partOf(p.name);
  if (parts === "bad") return unmatched(rt, p.id, p.name, "Ein Druck hat einen Teil-Zusatz, der nicht passt (z. B. „(3/2)“); nichts eingetragen.");
  let quote: Quote | null;
  let assumed = false;
  if (number) {
    quote = await quoteByNumber(rt, number);
    if (!quote) return unmatched(rt, p.id, p.name, `Der Druck nennt ${number}, aber dieses Angebot gibt es nicht; nichts eingetragen.`);
    if (quote.statusId !== APPROVED && quote.statusId !== CONVERTED)
      return unmatched(rt, p.id, p.name, `Der Druck nennt ${number}, aber das Angebot ist noch nicht angenommen; nichts eingetragen.`);
  } else if (p.name && waiting.length === 1) {
    quote = waiting[0]!;
    assumed = true;
  } else {
    const which = waiting.length === 0 ? "kein Angebot wartet" : `es warten ${waiting.length} Angebote (${waiting.map((q) => q.number).join(", ")})`;
    return unmatched(
      rt,
      p.id,
      p.name,
      `Ein Druck ohne Angebotsnummer im Namen läuft, und ${which}. Ihn in Invoice Ninja von Hand eintragen; beim nächsten die Nummer in den Namen setzen (z. B. „${waiting[0]?.number ?? "3D-2026-0010"} Vase“).`,
    );
  }
  rt.store.insertPrint(
    {
      start: p.id,
      task: p.name,
      quote_id: quote.id,
      quote_number: quote.number,
      part: parts?.part ?? null,
      parts: parts?.parts ?? null,
      state: "running",
      assumed: assumed ? 1 : 0,
    },
    now(rt),
  );
  if (quote.statusId === APPROVED) await setDruckstatus(rt, "quotes", quote.id, "im Druck");
  rt.log.info({ quote: quote.number, assumed }, "print-bridge: a print started");
  if (assumed)
    await push(rt, {
      title: `Druck zugeordnet: ${quote.number}`,
      message: `Ein Druck ohne Angebotsnummer im Namen läuft; es wartet nur ${quote.number}, also ist er dort eingetragen.`,
    });
  return rt.store.print(p.id)!;
}

function duration(p: Print): string | null {
  const minutes =
    p.seconds !== null
      ? Math.round(p.seconds / 60)
      : p.startedAt && p.completedAt
        ? Math.round((Date.parse(p.completedAt) - Date.parse(p.startedAt)) / 60_000)
        : NaN;
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

const de = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 1 });

async function finish(rt: Runtime, row: PrintRow, p: Print): Promise<void> {
  const took = duration(p);
  const what = [took, p.grams !== null ? `${de(p.grams)} g` : null].filter(Boolean).join(", ");
  if (!row.note_written) {
    const day = new Date(p.completedAt ?? p.startedAt ?? now(rt)).toLocaleDateString("de-DE", {
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
  const others = rt.store.partsDone(row.quote_id!);
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
