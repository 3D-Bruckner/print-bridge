# print-bridge: the A1 at home and Invoice Ninja

Status: decided 2026-11-20 night by Claude on Marcel's word ("make sensible defaults … build everything … deploy"). Part of
3dbruckner.de's order flow (3D-Bruckner/orders, the spec's steps 3–4): after invoiceninja-bridge, everything from "the customer
approved the quote" to "the invoice draft is ready".

## What it does

Every minute, from the homelab (it only connects out):

1. **Approved quotes wait.** An approved quote (Invoice Ninja status `approved`) without a Druckstatus gets `wartet`.
2. **A print starts.** Home Assistant's `bambu_lab` integration says the A1 is printing (`running`, `prepare`, `pause`). The print
   is the quote whose number (`3D-2026-0010`) is in the print's task name; without a number, the one quote that is `wartet`, if there
   is exactly one (the push says it was assumed). The quote gets Druckstatus `im Druck`.
3. **A print ends.**
   - `finish`: the quote's private notes get a line `Gedruckt am <Datum>: <Aufgabe>, <Dauer>, <Gramm> g`. A task name ending in
     `(k/m)` (`3D-2026-0010 Vase (2/3)`) is part k of m. When the last part is done (or there are no parts), Druckstatus `fertig`, the
     quote is converted into an invoice **draft** (Invoice Ninja's own conversion: draft, documents copied, nothing sent), the invoice
     gets Druckstatus `fertig`, and Marcel gets a push.
   - `failed`: Druckstatus back to `wartet`, a push.
4. **Marcel** sends the invoice, ships, sets `verschickt` (Invoice Ninja, by hand).

## Decisions

- **P1 H1a, read only:** the A1 stays in cloud mode (MakerWorld and Bambu Handy keep working); prints are started from Bambu Studio
  or Handy as before. The bridge queues nothing.
- **P2 Home Assistant is the printer's source, not Bambuddy:** `bambu_lab` already reads the A1 (status, task name, weight in grams,
  start and end) with the printer in cloud mode; one `POST /api/template` per minute reads all of it. Bambuddy and Spoolman (queue,
  filament stock) would add a third MQTT client and ~300 MB on CT 107 (2 GiB, swapping) for nothing H1a uses. They stay possible later.
- **P3 No orders service:** Invoice Ninja is the job list (an approved quote with Druckstatus `wartet`); the bridge talks to it with a
  token of an Invoice Ninja user allowed only quotes and invoices (the order-flow spec's accepted risk).
- **P4 A print finds its quote by number in its name**, else the only waiting one; never a guess between two. A print with no quote
  is pushed and left alone.
- **P5 The first start doesn't act on what it finds:** the print the A1 reports at that moment is recorded as seen, so an old finished
  print never converts a quote.
- **P6 German in Invoice Ninja and the pushes** (Marcel's business language there); code and logs English.
- **P7 Runs on CT 107 (frigate-lxc)**, the printer's guest, as a homelab stack; image `ghcr.io/3d-bruckner/print-bridge`.
- **P8 Without its tokens it waits:** it starts, answers `/health` and logs that it isn't configured, so it can be deployed before
  Marcel makes the two tokens (Home Assistant long-lived token; Invoice Ninja user `print-bridge`).

## Settings

`PRINT_HA_URL` (Home Assistant on the LAN), `PRINT_HA_TOKEN`, `PRINT_HA_PRINTER` (the entity prefix, `a1_<serial>`),
`PRINT_INVOICENINJA_URL`, `PRINT_INVOICENINJA_TOKEN`, `PRINT_NTFY_URL`, `PRINT_QUOTE_PATTERN`
(`3D-\d{4}-\d{4}`), `PRINT_LOG_LEVEL`, `DATA_DIR`, `PORT`, `TZ`.
