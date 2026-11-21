# Order flow: from the order form to the A1 and back, around Invoice Ninja

Status: agreed 2026-11-20, fifth version. The whole flow from the order form to the invoice draft, across noticebox,
`noticebox/invoiceninja-bridge`, Invoice Ninja and this repository's print-bridge. There is no `orders` service: the print-bridge at
home reads and writes Invoice Ninja itself. Moved here on 2026-11-21 from the `3D-Bruckner/orders` repository (docs only, deleted).
Earlier versions kept orders in upload, then made upload or an `orders` service the glue; upload is only the portfolio's photo upload.

## Goal

A request from the order form on 3dbruckner.de moves through every system without being typed twice, and Marcel decides every step:
he accepts the request in noticebox, prices and sends the quote in Invoice Ninja, starts the print at the A1, sends the invoice and
ships. Nothing reaches Invoice Ninja before he accepts, nothing is sent to a customer by the glue, nothing prints without his action.

## Where things are

| What | Where | Why |
|---|---|---|
| The request (Anfrage), until accepted or declined | noticebox, gewerbe-1 | the inbox: checks the form, takes the files, pushes to Marcel, deletes after 30 days. Invoice Ninja has no request before a quote |
| Client, quote, approval, invoice, payment, print state | Invoice Ninja, gewerbe-1 | the one source of truth for an order, with its UI and app |
| The handover: `invoiceninja-bridge` | gewerbe-1, next to noticebox | generic and open source (noticebox org): an accepted submission becomes client, draft quote and documents in Invoice Ninja, by a per-form field mapping |

| Print queue, filament | Bambuddy, Spoolman (homelab) | they talk to the A1 on the home network |
| print-bridge | homelab | every 5 min asks Invoice Ninja for approved quotes with Druckstatus `wartet`, queues them in Bambuddy, writes progress and results back; only connects out, nothing at home is reachable from outside |
| The portfolio | upload, products-1 | unchanged; no part in the order flow |

## The flow

```mermaid
sequenceDiagram
    autonumber
    actor C as Customer
    participant N as noticebox
    actor M as Marcel
    participant X as invoiceninja-bridge
    participant I as Invoice Ninja
    participant H as print-bridge (home)
    participant B as Bambuddy + A1
    C->>N: order form (text, address, files)
    N-->>M: push: new request
    M->>N: accepts it ("angenommen"), or declines it ("answered")
    N->>X: webhook: decided, new → angenommen (no content)
    X->>N: GET the submission and its files (read token)
    X->>I: client (find by email, or create with the address)
    X->>I: quote draft: request text, model link, files as documents
    M->>I: prices the quote, sends it
    C->>I: approves the quote (portal), or Marcel marks it approved
    Note over I: approved quote, Druckstatus "wartet": the print job
    M->>B: slices the model, sends it to the printer (archived)
    loop every 5 min
        H->>I: approved quotes with Druckstatus "wartet" (restricted user's token)
    end
    H->>B: queue the job's archive entry
    M->>B: plate clear, start
    H->>I: Druckstatus "im Druck" / "fertig", minutes and grams in the quote's notes
    H->>I: done: invoice draft from the quote
    H-->>M: push (ntfy): "fertig"
    M->>I: sends the invoice, ships, records the payment; Druckstatus "verschickt"
```

## noticebox

- **States of `3dbruckner-order`:** `new`; `angenommen` (closed: handed over to Invoice Ninja, noticebox's part ends here);
  `answered` (closed: declined or answered by hand); `test` (closed, deleted at once). A handover, no back and forth: the bridge only
  reads from noticebox and never writes to it. A failed handover is the bridge's to report (push) and retry.
- **Webhooks on every change of state** (a noticebox feature, its own release): besides today's post on arrival, every decision
  posts `{event: "decided", form, kind, id, from, to, at, url}`; the arrival post gains `event: "received"`. A webhook target may
  name the events it wants (`on: ["received", "decided"]`; without `on`, arrivals only, as today). As today: no content, no address, never delays or fails
  the decision. A test submission's arrival post carries `test: true`; decisions carry no such flag (a test submission is deleted as it arrives, so it is never decided).
- **What the bridge reads:** the submission (`GET /api/v1/submissions/{id}`) and its files (`GET /api/v1/submissions/{id}/files/{file}`)
  with a `read` `nbx_…` token.

## Invoice Ninja as the source of truth

- **The order is the quote.** Its own states are the commercial ones (draft, sent, approved, converted); the invoice's are paid or
  not. Nothing outside Invoice Ninja repeats them.
- **Everything from the request goes into Invoice Ninja**, so nothing is lost when noticebox deletes the request: the name, email and
  address into the client (an existing client found by email keeps its data; the address as given is in the quote's notes); the
  text, the model link (custom field "Modell-URL", `custom_value1`) and a link to the request into the quote's private notes; every
  file into the quote's documents, not shown in the portal.
- **Print state** is a custom field on quotes and invoices, "Druckstatus": `wartet`, `im Druck`, `fertig`, `verschickt`. The glue
  sets the first three; Marcel sets `verschickt`.

## invoiceninja-bridge

- Generic and open source, in the noticebox org (`noticebox/invoiceninja-bridge`, AGPL-3.0 like noticebox): for anyone who takes
  requests with a noticebox form and quotes in Invoice Ninja. A mapping per form says which state hands a submission over and which
  fields are the client's name, email and address and which go into a quote custom field; every other field goes into the quote's
  private notes under noticebox's own label; every file becomes a private document of the quote. Mappings are set over MCP and REST.
- Never writes to noticebox (a `read` token), only drafts in Invoice Ninja, no personal data of its own (a handover row of ids).
- Its own design and plan in its repository; step 2 below.

## The print-bridge and Invoice Ninja

- **No service in between.** The print-bridge at home talks to Invoice Ninja with an API token of its own, "print-bridge", on
  Marcel's account (2026-11-21: a restricted user would need a mailbox to accept its invite; the quick path was taken). Its token is in
  the homelab; the homelab only connects out.
- **The job list is Invoice Ninja's:** an approved quote with Druckstatus `wartet`. Status is per quote, not per line (enough for
  one printer; per line later in the line items' custom fields if needed).
- **Accepted risk:** a broken-into homelab could read and change quotes (customers' names and addresses included). Accepted
  2026-11-20 for one printer and this volume, against running a gateway service to narrow it.
- **Live since 2026-11-21:** print-bridge (this repository, design P1–P10 in
  [`2026-11-20-print-bridge-design.md`](2026-11-20-print-bridge-design.md)) on homelab CT 125 `workshop`, next to Bambuddy and
  Spoolman (homelab ADR-0249). H1 decided as **H1a, read only** (the A1 stays in cloud mode; prints are started from Bambu Studio
  or Handy). It reads **Bambuddy's print archive** (status, task name, grams, start, end) with a read-only API key; the first
  version read Home Assistant's bambu_lab, replaced on Marcel's word. A print finds its quote by the quote's number in its name
  (`3D-2026-0010 Vase`, parts as `(2/3)`), else the only waiting quote, never converted. Invoice Ninja's custom field `invoice2`
  is "Druckstatus" (dropdown, set 2026-11-20).

## Decisions

- **D1 Invoice Ninja holds the order,** the print jobs included (an approved quote with Druckstatus `wartet`); the bridge holds only
  handover rows of ids.
- **D2 Printing starts when the quote is approved in Invoice Ninja** (portal or Marcel), through its webhook.
- **D3 Which file Bambuddy prints:** an archive entry; a job gets one once Marcel has sliced the model and sent it to the printer.
  No shared folder. Settled in detail with step 4.
- **D5 The glue only ever writes drafts in Invoice Ninja:** it never sends a quote or an invoice.
- **D6 The customer hears from Marcel or Invoice Ninja, not from the glue;** "fertig" is a push to Marcel (ntfy).
- **D7 noticebox is the request (Anfrage);** nothing reaches Invoice Ninja before Marcel accepts it there. Declined requests and
  spam never become clients and are deleted with noticebox's retention.
- **D8 No `orders` service** (fifth version): first planned as the glue (second to fourth versions), then shrunk to a gateway, then
  dropped: the bridge does the handover, Invoice Ninja holds the job list, the print-bridge talks to Invoice Ninja with a restricted
  user. upload has no part in the order flow.
- **D9 The handover is generic:** `noticebox/invoiceninja-bridge`, open source, configured per form; not inside noticebox (V1, its
  ADR 0008: noticebox itself never sends content out) and not inside `orders` (nothing in it is about printing).
- Dropped from the second version: Invoice Ninja products from the portfolio prints, a Bambuddy entry per portfolio print, "Druck
  aus dem Portfolio" on the form. D4 (colours from stock on the form) stays for later.

## Order of work

1. **noticebox:** webhooks on every change of state, `on` per target; released and deployed; the form `3dbruckner-order` gets the
   state `angenommen`.
2. **invoiceninja-bridge:** the repository in the noticebox org, the mapping, the noticebox hook, client and quote draft with the
   text and the files; its docs site; deployed next to noticebox and tested with one real request.
3. **Invoice Ninja:** the custom field Druckstatus (`wartet`, `im Druck`, `fertig`, `verschickt`) on quotes and invoices, and the
   `print-bridge` user with its permissions and token (1Password, homelab vault).
4. **Homelab:** Bambuddy and Spoolman once Marcel has decided the A1's mode (H1 in homelab's 3D-workshop spec: cloud read-only, or
   LAN-only with Developer Mode); then the print-bridge against Invoice Ninja. In cloud mode it can only report prints, not queue
   them.
5. **The form (site):** what is still needed (D4 later).
