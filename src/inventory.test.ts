import { describe, expect, it } from "vitest";
import { averageCosts, keptColors, keptCosts, publicColors, refreshInventory } from "./inventory.ts";
import { fakeFetch } from "./testing/fetch.ts";
import { testRuntime } from "./testing/runtime.ts";

const spool = {
  material: "PLA",
  subtype: "Matte",
  color_name: "Blue",
  rgba: "5a9be0ff",
  brand: "Bambu Lab",
  weight_used: 107,
  note: "private",
  cost_per_kg: 15,
};

describe("the public colours", () => {
  it("carries only colour, material, finish and swatch", () => {
    expect(publicColors([spool])).toEqual([{ name: "Blue", material: "PLA", finish: "Matte", rgba: "5A9BE0FF" }]);
  });
  it("leaves out archived and broken spools, and lists a colour once", () => {
    expect(publicColors([spool, spool, { ...spool, color_name: "Red", archived_at: "2026-01-01" }, { ...spool, color_name: "Bad", rgba: "red" }])).toHaveLength(
      1,
    );
  });
});

describe("the costs", () => {
  it("averages the spools in stock that have a price", () => {
    const spools = [
      { material: "PLA", cost_per_kg: 15 },
      { material: "PLA", cost_per_kg: 17 },
      { material: "PLA", cost_per_kg: null },
      { material: "PLA", cost_per_kg: 90, archived_at: "2026-01-01" },
      { material: "PETG", cost_per_kg: 17.09 },
      { material: "TPU", cost_per_kg: 30 },
    ];
    expect(averageCosts(spools)).toEqual({ PLA: 16, PETG: 17.09 });
  });
});

describe("reading the inventory", () => {
  it("keeps both lists, and no cost in the public one", async () => {
    const rt = testRuntime();
    rt.fetch = fakeFetch(() => Response.json([spool])).fetch;
    expect(await refreshInventory(rt)).toBe(true);
    expect(keptColors(rt)).not.toContain("15");
    expect(keptColors(rt)).not.toContain("Bambu");
    expect(JSON.parse(keptCosts(rt)!)).toEqual({ version: 1, costs: { PLA: 15 } });
  });
  it("keeps the last lists when Bambuddy fails or is empty", async () => {
    const rt = testRuntime();
    rt.fetch = fakeFetch(() => Response.json([spool])).fetch;
    await refreshInventory(rt);
    const before = keptColors(rt);
    rt.fetch = fakeFetch(() => new Response("no", { status: 502 })).fetch;
    expect(await refreshInventory(rt)).toBe(false);
    rt.fetch = fakeFetch(() => Response.json([])).fetch;
    expect(await refreshInventory(rt)).toBe(true);
    expect(keptColors(rt)).toBe(before);
  });
});
