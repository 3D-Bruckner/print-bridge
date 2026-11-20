import { afterEach, describe, expect, it } from "vitest";
import { readPrinter } from "./homeassistant.ts";
import { fakeFetch } from "./testing/fetch.ts";
import { testRuntime } from "./testing/runtime.ts";
import type { Runtime } from "./runtime.ts";

const opened: Runtime[] = [];
afterEach(() => {
  for (const rt of opened.splice(0)) rt.store.close();
});

describe("readPrinter", () => {
  it("asks Home Assistant once, with the token, for the A1's bambu_lab entities", async () => {
    const rt = testRuntime();
    opened.push(rt);
    const f = fakeFetch(
      () => new Response('{"status": "running", "task": "3D-2026-0010 Vase", "grams": "48.6", "start": "2026-11-21T09:00:00+00:00", "end": "unknown"}'),
    );
    rt.fetch = f.fetch;
    expect(await readPrinter(rt)).toEqual({ status: "running", task: "3D-2026-0010 Vase", grams: 48.6, start: "2026-11-21T09:00:00+00:00", end: null });
    expect(f.calls[0]).toMatchObject({ url: "http://ha.test:8123/api/template", method: "POST", headers: { authorization: "Bearer ha_test" } });
    const t = (JSON.parse(String(f.calls[0]!.body)) as { template: string }).template;
    for (const e of ["druckstatus", "name_der_aufgabe", "gewicht_des_drucks", "startzeit", "endzeit"]) expect(t).toContain(`sensor.a1_test_${e}`);
  });

  it("is null while the printer is off", async () => {
    const rt = testRuntime();
    opened.push(rt);
    rt.fetch = fakeFetch(
      () => new Response('{"status": "unavailable", "task": "unavailable", "grams": "unavailable", "start": "unavailable", "end": "unavailable"}'),
    ).fetch;
    expect(await readPrinter(rt)).toBeNull();
  });
});
