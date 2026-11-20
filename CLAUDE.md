# CLAUDE.md

print-bridge: the A1 (through Home Assistant's bambu_lab) and Invoice Ninja, for 3dbruckner.de's orders. A plain Node/TypeScript
service, no framework, no sign-in, no API besides /health. Follows Marceltov/engineering-conventions; the rules here win. Design:
`docs/superpowers/specs/2026-11-20-print-bridge-design.md` (decisions P1–P8).

## Commands

`npm test` (Vitest), `npm run lint`, `npm run typecheck`, `npm run format` / `format:check` (Prettier, 160), `npm run build`. CI
(`.github/workflows/ci.yml`): `check`, then `image` builds, starts and pushes `ghcr.io/3d-bruckner/print-bridge`. Release: bump
package.json's version, merge, tag `vX.Y.Z`.

## Rules

- Never starts a print or sends anything to a customer; Invoice Ninja only gets Druckstatus, a notes line and its own conversion into
  a draft.
- Every step is stored before the next (`src/db`), so a retry writes nothing twice. The first start acts on nothing it finds (P5).
- Code and logs English; Invoice Ninja's notes and the pushes German (P6).
- `src/config.ts` (`VARIABLES`) and `.env.example` list the same variables (`config.test.ts`). Only `src/db/` touches the database.
- Tests never reach the network (`src/testing/services.ts` fakes Home Assistant, Invoice Ninja and ntfy).
- Merge only when Marcel says so.
