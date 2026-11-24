---
status: accepted
date: 2026-11-23
decision-makers: Marcel Bruckner
---

# print-bridge runs on gewerbe-1 and is the only service that calls Bambuddy

## Context and Problem Statement

The printing data took several paths: print-bridge and `printer-live` at home pushed to a receiver on gewerbe-1, and the portfolio called Bambuddy by itself. The homelab's ADR-0220 and ADR-0270 said nothing of 3dbruckner.de may reach into the home network, and the portfolio's call already broke that. Which service should sit between Bambuddy and the rest?

## Decision Drivers

- Fewer moving parts, one place that knows Bambuddy.
- No visitor request reaches home.
- Purchase costs stay private, and a hidden print stays hidden.
- No duplicate quote lines or invoice drafts from a move.

## Considered Options

- Keep the bridge at home and push to the receiver.
- Let the portfolio be the piece in the middle.
- Let the website's build call Bambuddy directly.
- **Merge print-bridge, `printer-live` and the receiver into one service on gewerbe-1 (chosen).**

## Decision Outcome

Chosen by Marcel: one service on gewerbe-1. The rule becomes: **no visitor request reaches home, and exactly one service, print-bridge, may call Bambuddy, with one limited key.** It uses Bambuddy's existing public address, with an API key that has "read status" only.

The public addresses stay the same (`live.3dbruckner.de`), so the website needs no change. The hide page stays at `printer-live.herziis.de` behind the homelab's Authentik, so everyone in the household keeps access; its Caddy forwards to the bridge with a token. Real slicing is not part of this: Bambuddy's slicer service is off, and it would need the broader "manage library" permission.

### Consequences

- Good, because three services become one, and three Bambuddy keys become one.
- Good, because the portfolio holds no Bambuddy key and only sees average costs.
- Good, because the bridge sits next to Invoice Ninja.
- Bad, because a public server now calls into home. If home is offline, the live picture and print tracking pause until it returns.
- Bad, because the bridge now serves public pages and no longer only connects out.
- Bad, because Bambuddy's snapshot route takes its token in the URL. It lasts 60 minutes and the home Caddy removes it from its access log, until maziggy/bambuddy#3707 allows a header.
- Bad, because a CrowdSec ban of gewerbe-1's address at home would cut the bridge off. `/health` names the jobs that went stale.
