import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { adoptOldState } from "./adopt.ts";
import { keptColors } from "./inventory.ts";
import { createLive, currentLive, liveRound, setHidden, statusFrom, type Live } from "./live.ts";
import type { Runtime } from "./runtime.ts";
import { fakeFetch, type Call } from "./testing/fetch.ts";
import { testRuntime } from "./testing/runtime.ts";

const JPEG = Buffer.from([0xff, 0xd8, 1, 2, 3]);
const T0 = Date.parse("2026-11-23T12:00:00Z");
let rt: Runtime;
let live: Live;
let now: number;
let printer: Record<string, unknown>;
let camera: () => Response;
let calls: Call[];
let tokensAccepted: Set<string>;
let minted: number;

beforeEach(() => {
  rt = testRuntime({ PRINT_CAMERA_NTFY_URL: "https://ntfy.test/camera" });
  now = T0;
  rt.clock = () => new Date(now);
  printer = { connected: true, state: "RUNNING", progress: 42.5, remaining_time: 30, subtask_name: "secret job" };
  camera = () => new Response(JPEG);
  minted = 0;
  tokensAccepted = new Set();
  const f = fakeFetch((c) => {
    const url = new URL(c.url);
    if (url.pathname.endsWith("/status")) return Response.json(printer);
    if (url.pathname.endsWith("/stream-token")) {
      const token = `t${++minted}`;
      tokensAccepted.add(token);
      return Response.json({ token });
    }
    if (url.pathname.endsWith("/snapshot")) return tokensAccepted.has(url.searchParams.get("token") ?? "") ? camera() : new Response(null, { status: 401 });
    if (c.url.startsWith("https://ntfy.test/")) return new Response("ok");
    throw new Error(`unexpected ${c.url}`);
  });
  rt.fetch = f.fetch;
  calls = f.calls;
  live = createLive(rt);
});

const pushes = () => calls.filter((c) => c.url.startsWith("https://ntfy.test/"));

describe("the public status", () => {
  it("says only status, progress and end time", async () => {
    await liveRound(rt, live);
    const { status, picture } = currentLive(live, now);
    expect(status).toEqual({ printing: true, paused: false, progress: 42, endsAt: "2026-11-23T12:30:00Z", pictureAt: "2026-11-23T12:00:00Z" });
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(picture).toEqual(JPEG);
  });
  it("reads anything doubtful as not printing", () => {
    expect(statusFrom(null, false, T0).printing).toBe(false);
    expect(statusFrom({ connected: false, state: "RUNNING" }, false, T0).printing).toBe(false);
    expect(statusFrom({ connected: true, state: "IDLE" }, false, T0).printing).toBe(false);
    expect(statusFrom({ connected: true, state: "RUNNING" }, true, T0).printing).toBe(false);
  });
  it("shows no picture older than 30 s", async () => {
    await liveRound(rt, live);
    now += 31_000;
    expect(currentLive(live, now)).toMatchObject({ status: { printing: false }, picture: null });
  });
  it("clears the picture when the camera or the status fails", async () => {
    await liveRound(rt, live);
    camera = () => new Response("no", { status: 500 });
    await liveRound(rt, live);
    expect(currentLive(live, now).picture).toBeNull();
    await liveRound(rt, live);
    printer = { connected: false };
    await liveRound(rt, live);
    expect(currentLive(live, now).status.printing).toBe(false);
  });
  it("refuses an answer that isn't a JPEG", async () => {
    camera = () => new Response("<html>");
    await liveRound(rt, live);
    expect(currentLive(live, now).picture).toBeNull();
  });
});

describe("the camera token", () => {
  it("is reused, renewed before it ends, and replaced when refused", async () => {
    await liveRound(rt, live);
    await liveRound(rt, live);
    expect(minted).toBe(1);
    now += 51 * 60_000;
    await liveRound(rt, live);
    expect(minted).toBe(2);
    tokensAccepted.clear();
    await liveRound(rt, live);
    expect(minted).toBe(3);
    expect(currentLive(live, now).picture).toEqual(JPEG);
  });
  it("is never in the log", async () => {
    const lines: unknown[] = [];
    const record = (...a: unknown[]) => void lines.push(a);
    rt.log = { info: record, warn: record, error: record } as unknown as Runtime["log"];
    camera = () => new Response("no", { status: 500 });
    await liveRound(rt, live);
    expect(JSON.stringify(lines)).not.toContain("t1");
  });
});

describe("the hide switch", () => {
  it("hides at once and survives a restart", async () => {
    await liveRound(rt, live);
    setHidden(rt, live, true);
    expect(currentLive(live, now).picture).toBeNull();
    expect(createLive(rt).hidden).toBe(true);
  });
  it("fetches no public picture while hidden", async () => {
    setHidden(rt, live, true);
    await liveRound(rt, live);
    expect(currentLive(live, now)).toMatchObject({ status: { printing: false }, picture: null });
  });
  it("returns to public when a print that really ran ends", async () => {
    await liveRound(rt, live);
    setHidden(rt, live, true);
    printer = { connected: true, state: "FINISH" };
    await liveRound(rt, live);
    expect(live.hidden).toBe(false);
    expect(createLive(rt).hidden).toBe(false);
  });
  it("stays hidden through a warm-up that falls back to idle", async () => {
    printer = { connected: true, state: "PREPARE" };
    await liveRound(rt, live);
    setHidden(rt, live, true);
    printer = { connected: true, state: "IDLE" };
    await liveRound(rt, live);
    expect(live.hidden).toBe(true);
  });
  it("reads an unreadable saved value as hidden", () => {
    rt.store.setState("live_hidden", "garbage");
    expect(createLive(rt).hidden).toBe(true);
  });
});

describe("the dead-camera alert", () => {
  it("pushes once after 10 minutes, and once when the camera is back", async () => {
    camera = () => new Response("no", { status: 500 });
    await liveRound(rt, live);
    now += 9 * 60_000;
    await liveRound(rt, live);
    expect(pushes()).toHaveLength(0);
    now += 60_000;
    await liveRound(rt, live);
    await liveRound(rt, live);
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0]!.url).toBe("https://ntfy.test/camera");
    camera = () => new Response(JPEG);
    await liveRound(rt, live);
    expect(pushes()).toHaveLength(2);
  });
  it("also watches a hidden print, keeping nothing of its picture", async () => {
    setHidden(rt, live, true);
    camera = () => new Response("no", { status: 500 });
    await liveRound(rt, live);
    now += 10 * 60_000;
    await liveRound(rt, live);
    expect(pushes()).toHaveLength(1);
    camera = () => new Response(JPEG);
    now += 60_000;
    await liveRound(rt, live);
    expect(currentLive(live, now).picture).toBeNull();
  });
});

describe("what the old services left", () => {
  it("takes over the hide switch and the colours once", () => {
    writeFileSync(join(rt.config.dataDir, "visibility.json"), JSON.stringify({ hidden: true }));
    writeFileSync(
      join(rt.config.dataDir, "colors.json"),
      JSON.stringify({ version: 1, colors: [{ name: "Blue", material: "PLA", finish: "Matte", rgba: "5A9BE0FF" }] }),
    );
    adoptOldState(rt, live);
    expect(live.hidden).toBe(true);
    expect(JSON.parse(keptColors(rt)!).colors).toHaveLength(1);
    writeFileSync(join(rt.config.dataDir, "visibility.json"), JSON.stringify({ hidden: false }));
    adoptOldState(rt, live);
    expect(live.hidden).toBe(true);
  });
  it("reads a broken switch file as hidden", () => {
    writeFileSync(join(rt.config.dataDir, "visibility.json"), "{");
    adoptOldState(rt, live);
    expect(live.hidden).toBe(true);
  });
});
