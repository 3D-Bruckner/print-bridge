import { describe, expect, it, vi } from "vitest";
import { publicColors, syncColors } from "./colors.ts";
import type { Runtime } from "./runtime.ts";

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

function runtime(answer: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer(String(url), init ?? {});
  });
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const rt = {
    config: { bambuddy: { url: "http://bambuddy.test", key: "bb_test" }, colors: { url: "https://live.test/colors", token: "colors_test" } },
    fetch,
    log,
  } as unknown as Runtime;
  return { rt, calls, log };
}

describe("publicColors", () => {
  it("keeps only the public fields", () => {
    expect(publicColors([spool])).toEqual([{ name: "Blue", material: "PLA", finish: "Matte", rgba: "5A9BE0FF" }]);
  });

  it("lists a colour once, however many spools have it, and keeps other finishes apart", () => {
    const list = publicColors([spool, { ...spool, brand: "SUNLU" }, { ...spool, subtype: "Plus 2.0" }]);
    expect(list.map((c) => c.finish)).toEqual(["Matte", "Plus 2.0"]);
  });

  it("leaves out archived spools and entries it can't show", () => {
    expect(
      publicColors([
        { ...spool, archived_at: "2026-11-22" },
        { ...spool, rgba: "red" },
        { ...spool, color_name: " " },
        { ...spool, material: null },
      ]),
    ).toEqual([]);
  });

  it("does not depend on the order of the spools", () => {
    const a = { ...spool, color_name: "Azure" };
    expect(publicColors([spool, a])).toEqual(publicColors([a, spool]));
  });
});

describe("syncColors", () => {
  const inventory = (body: unknown) => (url: string) => (url.includes("/inventory/") ? Response.json(body) : new Response(null, { status: 204 }));

  it("sends the list with its own token", async () => {
    const { rt, calls } = runtime(inventory([spool]));
    await syncColors(rt);
    expect(calls[0]!.url).toBe("http://bambuddy.test/api/v1/inventory/spools");
    expect(calls[1]!.url).toBe("https://live.test/colors");
    expect(calls[1]!.init.method).toBe("PUT");
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer colors_test");
    const sent = String(calls[1]!.init.body);
    expect(JSON.parse(sent)).toEqual({ version: 1, colors: [{ name: "Blue", material: "PLA", finish: "Matte", rgba: "5A9BE0FF" }] });
    expect(sent).not.toMatch(/Bambu Lab|private|cost/);
  });

  it("sends nothing for an empty inventory, so the last list stays", async () => {
    const { rt, calls } = runtime(inventory([]));
    await syncColors(rt);
    expect(calls).toHaveLength(1);
  });

  it("logs a failure and never throws", async () => {
    const { rt, log } = runtime(() => new Response(null, { status: 500 }));
    await expect(syncColors(rt)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("does nothing without its token", async () => {
    const { rt, calls } = runtime(inventory([spool]));
    rt.config.colors.token = null;
    await syncColors(rt);
    expect(calls).toHaveLength(0);
  });
});
