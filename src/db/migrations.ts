// print-bridge.sqlite's schema, in order, run at open (connection.ts) and recorded in PRAGMA user_version. A migration that has
// shipped is never edited: a change is a new migration at the end.
export type Migration = { name: string; sql: string };

export const MIGRATIONS: Migration[] = [
  {
    // One row per print the A1 reported, by its start time (the printer's own id for a print is not exposed): which quote it belongs
    // to, which part of how many, and how far the bridge got with it. seen: found at the first start and never acted on (design P5).
    // note_written: the quote's "Gedruckt am …" line is there, so a retry doesn't write it twice. assumed: matched as the only waiting
    // quote, not by number; such a print is noted but never converts the quote (review C2).
    name: "prints",
    sql: `
      create table prints (
        start text primary key,
        task text not null,
        quote_id text,
        quote_number text,
        part integer,
        parts integer,
        state text not null check (state in ('seen', 'running', 'unmatched', 'done', 'failed')),
        note_written integer not null default 0,
        assumed integer not null default 0,
        updated_at text not null
      );
      create table bridge_state (key text primary key, value text not null);
    `,
  },
];
