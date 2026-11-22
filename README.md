# print-bridge

3dbruckner.de's printer at home and Invoice Ninja. Every minute it:

- **marks approved quotes as waiting:** an approved quote gets Druckstatus `wartet`;
- **follows the print:** it reads the Bambu A1's prints from Bambuddy's archive, and when a print starts, its quote is `im Druck`;
- **finishes the quote:** when the print ends, the quote gets a line with the time and grams, Druckstatus `fertig`, and an invoice **draft**, and Marcel gets a push.

A print finds its quote by the quote's number in its name (`3D-2026-0010 Vase`, or `3D-2026-0010 Vase (2/3)` for part 2 of 3). Without a number, it takes the only quote that is waiting. Every five minutes it also sends the public filament colours from Bambuddy's inventory (colour, material and finish, never a brand, weight, price or note) to gewerbe-1, where 3dbruckner.de's build reads them. This runs apart from the orders, so a failure there holds nothing up.

The bridge sends nothing to a customer and starts no print.

It runs in the homelab next to the printer and only connects out. The design and its decisions: [`docs/superpowers/specs/2026-11-20-print-bridge-design.md`](docs/superpowers/specs/2026-11-20-print-bridge-design.md). The whole order flow, from the order form to the invoice draft: [`docs/superpowers/specs/2026-11-20-order-flow-design.md`](docs/superpowers/specs/2026-11-20-order-flow-design.md).

AGPL-3.0-only.
