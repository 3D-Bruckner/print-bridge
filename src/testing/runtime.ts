// A runtime for a test: a fresh print-bridge.sqlite under the test's DATA_DIR, a fetch that fails unless the test replaces it, a clock
// the test sets, and a silent log.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { loadConfig } from "../config.ts";
import { openRuntime, type Runtime } from "../runtime.ts";

export const TEST_ENV = {
  PRINT_BAMBUDDY_URL: "http://bambuddy.test:8000",
  PRINT_BAMBUDDY_KEY: "bb_test",
  PRINT_INVOICENINJA_URL: "https://invoices.test",
  PRINT_INVOICENINJA_TOKEN: "in_test",
  PRINT_NTFY_URL: "https://ntfy.test/topic",
};

export function testRuntime(env: Record<string, string> = {}): Runtime {
  const dataDir = mkdtempSync(join(process.env.DATA_DIR!, "rt-"));
  const all: Record<string, string> = { ...TEST_ENV, DATA_DIR: dataDir, TZ: "Europe/Berlin", ...env };
  for (const [k, v] of Object.entries(all)) if (v === "") delete all[k];
  const rt = openRuntime(loadConfig(all));
  return {
    ...rt,
    log: pino({ level: "silent" }),
    fetch: (async (url: string | URL | Request) => {
      throw new Error(`a test reached the network: ${String(url)}`);
    }) as typeof fetch,
  };
}
