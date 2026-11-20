// Invoice Ninja v5 with a token of a user allowed quotes and invoices: approved quotes, a quote by number, Druckstatus (custom_value2,
// "Druckstatus|wartet,im Druck,fertig,verschickt" in the company's custom fields), a line added to a quote's private notes, and the
// conversion of a quote into an invoice draft (Invoice Ninja's own: a draft, the documents copied, nothing sent).
import type { Runtime } from "./runtime.ts";
import { call } from "./serviceerror.ts";

export type Quote = { id: string; number: string; statusId: string; druckstatus: string; privateNotes: string; invoiceId: string };
export type Druckstatus = "wartet" | "im Druck" | "fertig" | "verschickt";

type Raw = { id: string; number: string; status_id: string; custom_value2?: string; private_notes?: string; invoice_id?: string };
const toQuote = (q: Raw): Quote => ({
  id: q.id,
  number: q.number,
  statusId: String(q.status_id),
  druckstatus: q.custom_value2 ?? "",
  privateNotes: q.private_notes ?? "",
  invoiceId: q.invoice_id ?? "",
});

async function api<T>(rt: Runtime, method: string, path: string, body?: unknown): Promise<T> {
  const r = await call(rt, "invoiceninja", `${rt.config.invoiceNinja.url}/api/v1${path}`, {
    method,
    headers: {
      "X-API-TOKEN": rt.config.invoiceNinja.token ?? "",
      "X-Requested-With": "XMLHttpRequest",
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: 20_000,
  });
  try {
    return (await r.json()) as T;
  } catch {
    throw new Error("invoiceninja sent an answer that isn't JSON");
  }
}

export const APPROVED = "3";
export const CONVERTED = "4";

export async function approvedQuotes(rt: Runtime): Promise<Quote[]> {
  const { data } = await api<{ data: Raw[] }>(rt, "GET", `/quotes?${new URLSearchParams({ client_status: "approved", per_page: "100" })}`);
  return data.filter((q) => String(q.status_id) === APPROVED).map(toQuote);
}

export async function quoteByNumber(rt: Runtime, number: string): Promise<Quote | null> {
  const { data } = await api<{ data: Raw[] }>(rt, "GET", `/quotes?${new URLSearchParams({ number })}`);
  const q = data.find((x) => x.number === number);
  return q ? toQuote(q) : null;
}

export async function getQuote(rt: Runtime, id: string): Promise<Quote> {
  return toQuote((await api<{ data: Raw }>(rt, "GET", `/quotes/${encodeURIComponent(id)}`)).data);
}

export async function setDruckstatus(rt: Runtime, entity: "quotes" | "invoices", id: string, value: Druckstatus): Promise<void> {
  await api(rt, "PUT", `/${entity}/${encodeURIComponent(id)}`, { custom_value2: value });
}

/** Adds `line` to the quote's private notes, unless it is there already (an earlier try whose answer was lost). */
export async function addQuoteNote(rt: Runtime, id: string, line: string): Promise<void> {
  const q = await getQuote(rt, id);
  if (q.privateNotes.split("\n").includes(line)) return;
  await api(rt, "PUT", `/quotes/${encodeURIComponent(id)}`, { private_notes: q.privateNotes ? `${q.privateNotes}\n${line}` : line });
}

/** The quote as an invoice draft: Invoice Ninja's conversion, or the invoice an earlier conversion made. */
export async function invoiceFor(rt: Runtime, quoteId: string): Promise<{ id: string; number: string }> {
  let q = await getQuote(rt, quoteId);
  if (q.statusId !== CONVERTED || !q.invoiceId) {
    await api(rt, "POST", "/quotes/bulk", { action: "convert_to_invoice", ids: [quoteId] });
    q = await getQuote(rt, quoteId);
    if (!q.invoiceId) throw new Error("Invoice Ninja did not convert the quote");
  }
  const inv = (await api<{ data: { id: string; number: string } }>(rt, "GET", `/invoices/${encodeURIComponent(q.invoiceId)}`)).data;
  return { id: inv.id, number: inv.number };
}
