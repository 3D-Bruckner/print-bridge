import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase } from "./connection.ts";
import { MIGRATIONS } from "./migrations.ts";

it("opens print-bridge.sqlite at the last migration, and again without running one twice", () => {
  const dir = mkdtempSync(join(process.env.DATA_DIR!, "db-"));
  openDatabase(dir).raw.close();
  const { raw } = openDatabase(dir);
  expect(raw.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
  expect(raw.prepare("select name from sqlite_master where type = 'table' order by name").pluck().all()).toEqual(["bridge_state", "prints"]);
  raw.close();
});
