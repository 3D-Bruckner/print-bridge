import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configured, loadConfig, VARIABLES } from "./config.ts";
import { TEST_ENV } from "./testing/runtime.ts";

describe("loadConfig", () => {
  it("reads every setting, and waits without the tokens", () => {
    const c = loadConfig(TEST_ENV);
    expect(c).toMatchObject({ ha: { url: "http://ha.test:8123", token: "ha_test", printer: "a1_test" }, dataDir: "/data", port: 8080 });
    expect(c.quotePattern.test("3D-2026-0010 Vase")).toBe(true);
    expect(configured(c)).toBe(true);
    expect(configured(loadConfig({ ...TEST_ENV, PRINT_HA_TOKEN: "" }))).toBe(false);
  });

  it("names what is wrong", () => {
    expect(() => loadConfig({ ...TEST_ENV, PRINT_HA_URL: "ha", PRINT_HA_PRINTER: "Sensor A1" })).toThrow(/PRINT_HA_URL.*PRINT_HA_PRINTER/);
    expect(() => loadConfig({ ...TEST_ENV, PRINT_QUOTE_PATTERN: "(" })).toThrow(/PRINT_QUOTE_PATTERN/);
  });
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

describe("the settings' lists", () => {
  it("envExampleListsEveryVariable", () => {
    const root = join(import.meta.dirname, "..");
    const known = Object.keys(VARIABLES).sort();
    const inEnv = [...new Set([...readFileSync(join(root, ".env.example"), "utf8").matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]!))].sort();
    expect(inEnv).toEqual(known);
    for (const f of sources(join(root, "src")))
      for (const m of readFileSync(f, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) expect(known).toContain(m[1]);
  });
});
