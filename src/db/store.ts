// The Store: every query the print-bridge makes. Domain code gets it as rt.store and never sees kysely or better-sqlite3.
import type { Selectable } from "kysely";
import { databaseAnswers, openDatabase } from "./connection.ts";
import type { PrintsTable } from "./schema.ts";

export type PrintRow = Selectable<PrintsTable>;
export type PrintPatch = Partial<Omit<PrintRow, "start">>;

export type Store = {
  print(start: string): PrintRow | undefined;
  insertPrint(row: Omit<PrintRow, "note_written" | "updated_at">, at: string): void;
  updatePrint(start: string, patch: PrintPatch, at: string): void;
  /** How many parts of the quote's print are done. */
  partsDone(quoteId: string): number;
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
  transaction<T>(fn: () => T): T;
  answers(): boolean;
  close(): void;
};

export function openStore(dataDir: string): Store {
  const { exec, raw } = openDatabase(dataDir);
  const { q, first, run } = exec;
  return {
    print: (start) => first(q.selectFrom("prints").selectAll().where("start", "=", start)),
    insertPrint: (row, at) => void run(q.insertInto("prints").values({ ...row, updated_at: at })),
    updatePrint: (start, patch, at) =>
      void run(
        q
          .updateTable("prints")
          .set({ ...patch, updated_at: at })
          .where("start", "=", start),
      ),
    partsDone: (quoteId) =>
      first(
        q
          .selectFrom("prints")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("quote_id", "=", quoteId)
          .where("state", "=", "done"),
      )?.n ?? 0,
    getState: (key) => first(q.selectFrom("bridge_state").select("value").where("key", "=", key))?.value,
    setState: (key, value) =>
      void run(
        q
          .insertInto("bridge_state")
          .values({ key, value })
          .onConflict((oc) => oc.column("key").doUpdateSet({ value })),
      ),
    transaction: (fn) => raw.transaction(fn)(),
    answers: () => databaseAnswers(raw),
    close: () => raw.close(),
  };
}
