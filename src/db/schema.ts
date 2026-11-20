// The tables of print-bridge.sqlite as kysely sees them (migrations.ts creates them). Generated: a column with a default.
import type { Generated } from "kysely";

export interface PrintsTable {
  start: string;
  task: string;
  quote_id: string | null;
  quote_number: string | null;
  part: number | null;
  parts: number | null;
  state: "seen" | "running" | "unmatched" | "done" | "failed";
  /** 0 or 1. */
  note_written: Generated<number>;
  updated_at: string;
}

export interface DB {
  prints: PrintsTable;
  bridge_state: { key: string; value: string };
}
