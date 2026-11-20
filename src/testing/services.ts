// Bambuddy's archive (GET /api/v1/archives/), Invoice Ninja (quotes, invoices, their conversion) and ntfy in memory behind a fake fetch,
// in the shapes the real ones answer with (Bambuddy 1.3.1's ArchiveResponse, Invoice Ninja 5.13). `printer` is what the A1 does now;
// every start it reports becomes an archive entry of its own, as Bambuddy makes one per print.
import type { Runtime } from "../runtime.ts";
import { fakeFetch, type Call } from "./fetch.ts";

export type Printer = { status: string; task: string; grams: string; start: string; end: string };
export type FakeQuote = { id: string; number: string; status_id: string; custom_value2: string; private_notes: string; invoice_id: string };
export type FakeInvoice = { id: string; number: string; status_id: string; custom_value2: string; quote: string };

export function fakeServices(rt: Runtime, printer: Printer) {
  const quotes = new Map<string, FakeQuote>();
  const archives = new Map<string, Record<string, unknown>>();
  const invoices = new Map<string, FakeInvoice>();
  const pushes: { title: string; message: string }[] = [];
  let fail: (c: Call) => Response | undefined = () => undefined;
  let n = 0;
  const f = fakeFetch(async (c) => {
    const refused = fail(c);
    if (refused) return refused;
    const url = new URL(c.url);
    if (rt.config.ntfyUrl && c.url.startsWith(rt.config.ntfyUrl)) {
      pushes.push({ title: c.headers.title!, message: String(c.body) });
      return new Response("ok");
    }
    if (c.url.startsWith(`${rt.config.bambuddy.url}/api/v1/archives/`)) {
      if (c.headers["x-api-key"] !== "bb_test") return new Response(JSON.stringify({ detail: "Not authenticated" }), { status: 401 });
      const status = { running: "printing", finish: "completed", failed: "failed" }[printer.status];
      const start = Date.parse(printer.start);
      if (status && !Number.isNaN(start)) {
        const key = String(start);
        const a = archives.get(key) ?? { id: archives.size + 1, filename: "plate_1.3mf" };
        const seconds = Math.round((Date.parse(printer.end) - start) / 1000);
        Object.assign(a, {
          print_name: printer.task,
          status,
          started_at: printer.start,
          completed_at: status === "printing" ? null : printer.end,
          actual_time_seconds: status === "printing" || Number.isNaN(seconds) ? null : seconds,
          filament_used_grams: Number(printer.grams),
        });
        archives.set(key, a);
      }
      return Response.json([...archives.values()].sort((x, y) => Number(y.id) - Number(x.id)));
    }
    if (c.url.startsWith(`${rt.config.invoiceNinja.url}/api/v1/`)) {
      if (c.headers["x-api-token"] !== rt.config.invoiceNinja.token) return new Response(null, { status: 401 });
      const p = url.pathname.slice("/api/v1".length);
      if (p === "/quotes" && c.method === "GET") {
        const number = url.searchParams.get("number");
        const status = url.searchParams.get("client_status");
        const list = [...quotes.values()].filter((q) => (number ? q.number === number : true) && (status === "approved" ? q.status_id === "3" : true));
        return Response.json({ data: list });
      }
      const m = p.match(/^\/(quotes|invoices)\/([^/]+)$/);
      if (m && m[2] !== "bulk") {
        const store = m[1] === "quotes" ? quotes : invoices;
        const e = store.get(m[2]!) as Record<string, unknown> | undefined;
        if (!e) return new Response(null, { status: 404 });
        if (c.method === "PUT") Object.assign(e, JSON.parse(String(c.body)));
        return Response.json({ data: e });
      }
      if (p === "/quotes/bulk" && c.method === "POST") {
        const { action, ids } = JSON.parse(String(c.body)) as { action: string; ids: string[] };
        if (action !== "convert_to_invoice") return new Response(null, { status: 400 });
        for (const id of ids) {
          const q = quotes.get(id)!;
          if (q.status_id !== "3") continue;
          const inv = { id: `i${++n}`, number: `3D-2026-${String(4 + n).padStart(4, "0")}`, status_id: "1", custom_value2: q.custom_value2, quote: q.id };
          invoices.set(inv.id, inv);
          Object.assign(q, { status_id: "4", invoice_id: inv.id });
        }
        return Response.json({ data: ids.map((id) => quotes.get(id)) });
      }
      return new Response(null, { status: 404 });
    }
    throw new Error(`a test reached the network: ${c.url}`);
  });
  rt.fetch = f.fetch;
  return {
    calls: f.calls,
    printer,
    archives,
    quotes,
    invoices,
    pushes,
    quote: (number: string, over: Partial<FakeQuote> = {}) => {
      const q: FakeQuote = {
        id: `q${++n}`,
        number,
        status_id: "3",
        custom_value2: "",
        private_notes: "Request from noticebox: https://inbox.test/x",
        invoice_id: "",
        ...over,
      };
      quotes.set(q.id, q);
      return q;
    },
    failWhen: (rule: (c: Call) => Response | undefined) => void (fail = rule),
  };
}
