# print-bridge: the A1 at home and Invoice Ninja

Status: decided 2026-11-20 night by Claude on Marcel's word ("make sensible defaults … build everything … deploy"). Part of
3dbruckner.de's order flow (3D-Bruckner/orders, the spec's steps 3–4): after invoiceninja-bridge, everything from "the customer
approved the quote" to "the invoice draft is ready".

## What it does

Every minute, from the homelab (it only connects out):

1. **Approved quotes wait.** An approved quote (Invoice Ninja status `approved`) without a Druckstatus gets `wartet`.
2. **A print starts.** Bambuddy's archive has a new entry that is `printing`. The print
   is the quote whose number (`3D-2026-0010`) is in the print's task name; without a number, the one quote that is `wartet`, if there
   is exactly one (the push says it was assumed). The quote gets Druckstatus `im Druck`.
3. **A print ends.**
   - `completed`: the quote's private notes get a line `Gedruckt am <Datum>: <Aufgabe>, <Dauer>, <Gramm> g`. A task name ending in
     `(k/m)` (`3D-2026-0010 Vase (2/3)`) is part k of m. When the last part is done (or there are no parts), Druckstatus `fertig`, the
     quote is converted into an invoice **draft** (Invoice Ninja's own conversion: draft, documents copied, nothing sent), the invoice
     gets Druckstatus `fertig`, and Marcel gets a push.
   - `failed` or `cancelled`: Druckstatus back to `wartet`, a push.
4. **Marcel** sends the invoice, ships, sets `verschickt` (Invoice Ninja, by hand).

## Decisions

- **P1 H1a, read only:** the A1 stays in cloud mode (MakerWorld and Bambu Handy keep working); prints are started from Bambu Studio
  or Handy as before. The bridge queues nothing.
- **P2 Bambuddy is the printer's source** (changed 2026-11-21 on Marcel's word, from Home Assistant's `bambu_lab`): Bambuddy (homelab
  CT 125) watches the A1 over the LAN and archives every print with its name, status, start, end, real time and grams; the bridge reads
  `GET /api/v1/archives/` with an API key that may only read. Each archive entry has its own id, which is the print's key. No Home
  Assistant token; Spoolman gets the filament used from Bambuddy.
- **P3 No orders service:** Invoice Ninja is the job list (an approved quote with Druckstatus `wartet`); the bridge talks to it with a
  token of an Invoice Ninja user allowed only quotes and invoices (the order-flow spec's accepted risk).
- **P4 A print finds its quote by number in its name**, only an approved one (or a converted one, as a reprint); else the only
  waiting one, which is noted but never converted (Marcel converts by hand after the push); never a guess between two. A print with no
  quote is pushed and left alone. (Changed after the review of 2026-11-20: a wrong conversion is the worst outcome.)
- **P9 Converting only when certain:** the print was seen running, or began after the bridge first saw the printer on (an old
  "finish" after a night switched off is history); every part `1..m` done, each counted once; the quote not converted already (a
  reprint is noted and pushed, its invoice and Druckstatus untouched). Invoice Ninja's `auto_convert_quote` is off (checked
  2026-11-20), so approved quotes stay approved until the bridge or Marcel converts them.
- **P10 Stuck is pushed:** 30 failed minutes in a row (a wrong token, a service down, a wrong printer prefix) push once; `/health`
  shows the last minute that worked.
- **P5 The first start doesn't act on what it finds:** the print the A1 reports at that moment is recorded as seen, so an old finished
  print never converts a quote.
- **P6 German in Invoice Ninja and the pushes** (Marcel's business language there); code and logs English.
- **P7 Runs on CT 125 (workshop)** next to Bambuddy and Spoolman, as a homelab stack; image `ghcr.io/3d-bruckner/print-bridge`.
- **P8 Without its tokens it waits:** it starts, answers `/health` and logs that it isn't configured, so it can be deployed before
  the Bambuddy key and the Invoice Ninja token exist.

## Settings

`PRINT_BAMBUDDY_URL`, `PRINT_BAMBUDDY_KEY`,
`PRINT_INVOICENINJA_URL`, `PRINT_INVOICENINJA_TOKEN`, `PRINT_NTFY_URL`, `PRINT_QUOTE_PATTERN`
(`3D-\d{4}-\d{4}`), `PRINT_LOG_LEVEL`, `DATA_DIR`, `PORT`, `TZ`.
