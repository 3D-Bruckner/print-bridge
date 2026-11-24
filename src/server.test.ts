import { beforeEach, describe, expect, it } from "vitest";
import { refreshInventory } from "./inventory.ts";
import { createLive, liveRound, type Live } from "./live.ts";
import type { Runtime } from "./runtime.ts";
import { handle, type Jobs } from "./server.ts";
import { fakeFetch } from "./testing/fetch.ts";
import { testRuntime } from "./testing/runtime.ts";

const JPEG = Buffer.from([0xff, 0xd8, 9]);
let rt: Runtime;
let live: Live;
let jobs: Jobs;

const ask = (method: string, path: string, headers: Record<string, string> = {}, body = "") =>
  handle(rt, live, jobs, { method, path, header: (n) => headers[n], body: Buffer.from(body) });
const control = { authorization: "Bearer control", "sec-fetch-site": "same-origin" };

beforeEach(async () => {
  rt = testRuntime({ PRINT_CONTROL_TOKEN: "control", PRINT_COSTS_TOKEN: "costs" });
  rt.fetch = fakeFetch((c) => {
    if (c.url.endsWith("/status")) return Response.json({ connected: true, state: "RUNNING", progress: 10, remaining_time: 5 });
    if (c.url.endsWith("/stream-token")) return Response.json({ token: "t" });
    if (c.url.includes("/snapshot")) return new Response(JPEG);
    if (c.url.endsWith("/inventory/spools"))
      return Response.json([{ material: "PLA", color_name: "Blue", rgba: "5a9be0ff", cost_per_kg: 19.99, brand: "Secret" }]);
    throw new Error(`unexpected ${c.url}`);
  }).fetch;
  live = createLive(rt);
  jobs = { startedAt: rt.clock().getTime(), live: null, inventory: null };
  await refreshInventory(rt);
  await liveRound(rt, live);
});

describe("what everyone can read", () => {
  it("serves the status and the picture to the site", () => {
    const status = ask("GET", "/status.json");
    expect(status.headers).toMatchObject({ "Access-Control-Allow-Origin": "https://3dbruckner.de", "Cache-Control": "public, max-age=1" });
    expect(JSON.parse(String(status.body))).toMatchObject({ printing: true, progress: 10 });
    const picture = ask("GET", "/live.jpg");
    expect(picture.headers["Content-Type"]).toBe("image/jpeg");
    expect(picture.body).toEqual(JPEG);
  });
  it("serves the colours without a cost or a brand", () => {
    const colors = String(ask("GET", "/colors.json").body);
    expect(JSON.parse(colors).colors).toEqual([{ name: "Blue", material: "PLA", finish: null, rgba: "5A9BE0FF" }]);
    expect(colors).not.toContain("19.99");
    expect(colors).not.toContain("Secret");
  });
  it("answers HEAD with GET's headers and no body", () => {
    const head = ask("HEAD", "/live.jpg");
    expect(head.body).toBeNull();
    expect(head.headers["Content-Length"]).toBe(String(JPEG.length));
  });
  it("knows nothing else", () => {
    expect(ask("GET", "/nope").status).toBe(404);
    expect(ask("POST", "/status.json").status).toBe(404);
    expect(ask("PUT", "/colors").status).toBe(404);
    expect(ask("POST", "/push").status).toBe(404);
  });
});

describe("the costs", () => {
  it("need their token", () => {
    expect(ask("GET", "/costs").status).toBe(401);
    expect(ask("GET", "/costs", { authorization: "Bearer control" }).status).toBe(401);
    const ok = ask("GET", "/costs", { authorization: "Bearer costs" });
    expect(JSON.parse(String(ok.body))).toEqual({ version: 1, costs: { PLA: 19.99 } });
    expect(ok.headers["Cache-Control"]).toBe("no-store");
  });
  it("can't be read at all without a configured token", () => {
    rt.config.costsToken = null;
    expect(ask("GET", "/costs", { authorization: "Bearer " }).status).toBe(401);
  });
});

describe("the hide page", () => {
  it("needs its token", () => {
    expect(ask("GET", "/control").status).toBe(403);
    expect(ask("GET", "/control", { authorization: "Bearer costs" }).status).toBe(403);
    expect(String(ask("GET", "/control", control).body)).toContain("Öffentlich");
  });
  it("hides and shows again, from its own page only", () => {
    expect(ask("POST", "/control/visibility", { authorization: "Bearer control", "sec-fetch-site": "cross-site" }, "hidden=1").status).toBe(403);
    expect(ask("POST", "/control/visibility", {}, "hidden=1").status).toBe(403);
    expect(ask("POST", "/control/visibility", control, "hidden=2").status).toBe(400);
    const hidden = ask("POST", "/control/visibility", control, "hidden=1");
    expect(hidden).toMatchObject({ status: 303, headers: { Location: "/" } });
    expect(ask("GET", "/live.jpg").status).toBe(404);
    expect(JSON.parse(String(ask("GET", "/status.json").body)).printing).toBe(false);
    expect(ask("POST", "/control/visibility", control, "hidden=0").status).toBe(303);
    expect(live.hidden).toBe(false);
  });
});

describe("the health", () => {
  it("names a job that has had no success for too long", () => {
    expect(JSON.parse(String(ask("GET", "/health").body)).stale).toEqual([]);
    const later = rt.clock().getTime() + 6 * 60_000;
    rt.clock = () => new Date(later);
    expect(JSON.parse(String(ask("GET", "/health").body)).stale).toEqual(["live"]);
  });
});
