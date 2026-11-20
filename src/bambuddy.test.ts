import { afterEach, describe, expect, it } from "vitest";
import { recentPrints } from "./bambuddy.ts";
import { fakeFetch } from "./testing/fetch.ts";
import { testRuntime } from "./testing/runtime.ts";
import type { Runtime } from "./runtime.ts";

const opened: Runtime[] = [];
afterEach(() => {
  for (const rt of opened.splice(0)) rt.store.close();
});

describe("recentPrints", () => {
  it("reads Bambuddy's archive with the API key, oldest first, in its own words", async () => {
    const rt = testRuntime();
    opened.push(rt);
    const f = fakeFetch(() =>
      Response.json([
        {
          id: 8,
          print_name: "3D-2026-0010 Vase",
          filename: "vase.3mf",
          status: "cancelled",
          started_at: "2026-11-21T09:00:00Z",
          completed_at: "2026-11-21T09:10:00Z",
          actual_time_seconds: 600,
          filament_used_grams: 3.2,
        },
        {
          id: 7,
          print_name: null,
          filename: "Benchy.3mf",
          status: "completed",
          started_at: null,
          completed_at: null,
          actual_time_seconds: null,
          filament_used_grams: null,
        },
      ]),
    );
    rt.fetch = f.fetch;
    expect(await recentPrints(rt)).toEqual([
      { id: "7", name: "Benchy.3mf", status: "completed", startedAt: null, completedAt: null, seconds: null, grams: null },
      {
        id: "8",
        name: "3D-2026-0010 Vase",
        status: "failed",
        startedAt: "2026-11-21T09:00:00Z",
        completedAt: "2026-11-21T09:10:00Z",
        seconds: 600,
        grams: 3.2,
      },
    ]);
    expect(f.calls[0]).toMatchObject({ url: "http://bambuddy.test:8000/api/v1/archives/?limit=20", headers: { "x-api-key": "bb_test" } });
  });
});
