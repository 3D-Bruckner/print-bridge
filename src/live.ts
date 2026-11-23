// The printer's live picture for 3dbruckner.de, only while it prints. Every 3 s the bridge reads the printer's status from Bambuddy; while
// a print runs and isn't hidden it also fetches a camera picture, which visitors get from this service. Only status, progress and end
// time are public, never the job's name.
//
// A dead source never shows stale data: a failed status, a camera failure or a picture older than 30 s all read as "not printing". The
// hide switch survives a restart, an unreadable value means hidden, and it returns to public when a print that really ran ends. A running
// print without a camera picture for 10 minutes sends one push, also for a hidden print, whose probe picture is discarded.
//
// Bambuddy's snapshot route only takes a token in its URL. The token is asked for with the API key, lasts 60 minutes and is never logged.
import { push } from "./push.ts";
import type { Runtime } from "./runtime.ts";
import { call, ServiceError } from "./serviceerror.ts";

export const LIVE_EVERY_MS = 3_000;
const PRINTER = 1;
const PICTURE_MAX_AGE_MS = 30_000;
const MAX_PICTURE_BYTES = 1024 * 1024;
const TOKEN_LASTS_MS = 50 * 60_000;
const CAMERA_DEAD_AFTER_MS = 10 * 60_000;
const CAMERA_PROBE_EVERY_MS = 60_000;
const CAMERA_DEAD = "Der Druck läuft, aber die Kamera liefert seit 10 Minuten kein Bild. Die Spaghetti-Erkennung ist blind.";
const CAMERA_BACK = "Die Druckerkamera liefert wieder Bilder.";
const HIDDEN = "live_hidden";
const PRINTING = new Set(["RUNNING", "PREPARE", "PAUSE"]);
const REALLY_PRINTED = new Set(["RUNNING", "PAUSE"]); // PREPARE can fall back to IDLE on the way into a print
const ENDED = new Set(["FINISH", "FAILED", "IDLE"]);

export type PublicStatus = { printing: boolean; paused: boolean; progress: number | null; endsAt: string | null };
export type Served = PublicStatus & { pictureAt: string | null };
type Printer = { connected?: unknown; state?: unknown; progress?: unknown; remaining_time?: unknown };
type Snapshot = { status: PublicStatus; picture: Buffer | null; at: number | null };

export type Live = {
  hidden: boolean;
  printer: Printer | null;
  wasPrinting: boolean;
  snapshot: Snapshot;
  token: { value: string; until: number } | null;
  failingSince: number | null;
  alerted: boolean;
  lastProbe: number | null;
  lastReason: string | null;
};

const NOT_PRINTING: PublicStatus = { printing: false, paused: false, progress: null, endsAt: null };
const nothing = (): Snapshot => ({ status: { ...NOT_PRINTING }, picture: null, at: null });
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function progress(v: unknown): number | null {
  if (typeof v !== "number" && typeof v !== "string") return null;
  const p = Math.trunc(Number(v));
  return v !== "" && Number.isFinite(p) && p >= 0 && p <= 100 ? p : null;
}

function endsAt(minutes: unknown, now: number): string | null {
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes <= 0) return null;
  const at = now + minutes * 60_000;
  return Number.isNaN(new Date(at).getTime()) ? null : iso(at);
}

/** The public status from Bambuddy's answer; anything doubtful is "not printing". */
export function statusFrom(printer: Printer | null, hidden: boolean, now: number): PublicStatus {
  if (hidden || printer?.connected !== true || typeof printer.state !== "string" || !PRINTING.has(printer.state)) return { ...NOT_PRINTING };
  return { printing: true, paused: printer.state === "PAUSE", progress: progress(printer.progress), endsAt: endsAt(printer.remaining_time, now) };
}

function readHidden(rt: Runtime): boolean {
  try {
    const v = rt.store.getState(HIDDEN);
    return v === undefined ? false : v !== "false";
  } catch {
    return true;
  }
}

function saveHidden(rt: Runtime, hidden: boolean): void {
  try {
    rt.store.setState(HIDDEN, String(hidden));
  } catch (e) {
    rt.log.warn({ error: e instanceof Error ? e.name : "error" }, "live: the hide switch wasn't saved");
  }
}

export function createLive(rt: Runtime): Live {
  return {
    hidden: readHidden(rt),
    printer: null,
    wasPrinting: false,
    snapshot: nothing(),
    token: null,
    failingSince: null,
    alerted: false,
    lastProbe: null,
    lastReason: null,
  };
}

/** The hide switch, in force at once even if saving fails. */
export function setHidden(rt: Runtime, live: Live, hidden: boolean): void {
  const p = live.printer;
  if (!(p?.connected === true && typeof p.state === "string" && REALLY_PRINTED.has(p.state))) live.wasPrinting = false; // an end we never saw must not undo this
  live.hidden = hidden;
  saveHidden(rt, hidden);
  if (hidden) live.snapshot = nothing();
}

/** Keeps the old service's switch, unless the bridge has one already. */
export function adoptHidden(rt: Runtime, live: Live, hidden: boolean): void {
  if (rt.store.getState(HIDDEN) !== undefined) return;
  live.hidden = hidden;
  saveHidden(rt, hidden);
}

/** Status and picture as served now: no fresh picture, nothing shown. */
export function currentLive(live: Live, now: number): { status: Served; picture: Buffer | null } {
  const s = live.snapshot;
  if (live.hidden || !s.picture || s.at === null || now - s.at > PICTURE_MAX_AGE_MS) return { status: { ...NOT_PRINTING, pictureAt: null }, picture: null };
  return { status: { ...s.status, pictureAt: iso(s.at) }, picture: s.picture };
}

function updatePrinter(rt: Runtime, live: Live, printer: Printer | null): void {
  live.printer = printer;
  if (printer?.connected !== true || typeof printer.state !== "string") return;
  if (REALLY_PRINTED.has(printer.state)) live.wasPrinting = true;
  else if (ENDED.has(printer.state) && live.wasPrinting) {
    live.wasPrinting = false;
    live.hidden = false;
    saveHidden(rt, false);
  }
}

function logOnce(rt: Runtime, live: Live, reason: string | null): void {
  if (reason === live.lastReason) return;
  live.lastReason = reason;
  if (reason) rt.log.warn({ reason }, "live: no picture");
  else rt.log.info("live: picture ok");
}

const key = (rt: Runtime) => ({ "X-API-Key": rt.config.bambuddy.key ?? "", accept: "application/json" });

async function readStatus(rt: Runtime): Promise<Printer> {
  const r = await call(rt, "bambuddy", `${rt.config.bambuddy.url}/api/v1/printers/${PRINTER}/status`, { headers: key(rt), timeoutMs: 8_000 });
  const answer: unknown = await r.json().catch(() => null);
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error("bambuddy's status is not an object");
  return answer;
}

async function cameraToken(rt: Runtime, live: Live, now: number): Promise<string> {
  if (live.token && live.token.until > now) return live.token.value;
  const r = await call(rt, "bambuddy", `${rt.config.bambuddy.url}/api/v1/printers/camera/stream-token`, { method: "POST", headers: key(rt), timeoutMs: 8_000 });
  const answer = (await r.json().catch(() => null)) as { token?: unknown } | null;
  if (typeof answer?.token !== "string" || !answer.token) throw new Error("bambuddy sent no camera token");
  live.token = { value: answer.token, until: now + TOKEN_LASTS_MS };
  return answer.token;
}

/** One camera picture. A token Bambuddy no longer takes is replaced once. */
async function fetchPicture(rt: Runtime, live: Live, now: number): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    const token = await cameraToken(rt, live, now);
    const url = `${rt.config.bambuddy.url}/api/v1/printers/${PRINTER}/camera/snapshot?token=${encodeURIComponent(token)}`;
    const r = await call(rt, "bambuddy", url, { timeoutMs: 10_000 }, (s) => (s >= 200 && s < 300) || s === 401);
    if (r.status === 401) {
      live.token = null;
      if (attempt === 0) continue;
      throw new ServiceError("bambuddy", 401);
    }
    const body = Buffer.from(await r.arrayBuffer());
    if (body.length > MAX_PICTURE_BYTES) throw new Error("the camera's picture is too large");
    if (body[0] !== 0xff || body[1] !== 0xd8) throw new Error("the camera's answer is not a JPEG");
    return body;
  }
}

const reason = (e: unknown) => (e instanceof Error ? e.message : "error");

async function cameraPush(rt: Runtime, message: string): Promise<boolean> {
  return push(rt, { title: "3D-Drucker Kamera", message, priority: 3, tags: "camera", url: rt.config.cameraNtfyUrl ?? rt.config.ntfyUrl });
}

async function watchCamera(rt: Runtime, live: Live, publicOk: boolean | null, now: number): Promise<void> {
  if (!(live.printer?.connected === true && live.printer.state === "RUNNING")) {
    live.failingSince = null;
    live.alerted = false;
    live.lastProbe = null;
    return;
  }
  let ok = publicOk;
  if (ok === null) {
    if (live.lastProbe !== null && now - live.lastProbe < CAMERA_PROBE_EVERY_MS) ok = live.failingSince === null;
    else {
      live.lastProbe = now;
      ok = await fetchPicture(rt, live, now).then(
        () => true,
        () => false,
      );
    }
  }
  if (ok) {
    live.failingSince = null;
    if (live.alerted && (await cameraPush(rt, CAMERA_BACK))) live.alerted = false;
    return;
  }
  live.failingSince ??= now;
  if (!live.alerted && now - live.failingSince >= CAMERA_DEAD_AFTER_MS) live.alerted = await cameraPush(rt, CAMERA_DEAD);
}

/** One round; true when Bambuddy's status was read. Any failure clears the picture and the next round goes on. */
export async function liveRound(rt: Runtime, live: Live): Promise<boolean> {
  if (!rt.config.bambuddy.key) return false;
  const now = rt.clock().getTime();
  let read = true;
  try {
    updatePrinter(rt, live, await readStatus(rt));
  } catch (e) {
    read = false;
    updatePrinter(rt, live, null);
    logOnce(rt, live, `status: ${reason(e)}`);
  }
  const status = statusFrom(live.printer, live.hidden, now);
  let publicOk: boolean | null = null;
  if (status.printing) {
    try {
      const picture = await fetchPicture(rt, live, now);
      if (!live.hidden) live.snapshot = { status, picture, at: rt.clock().getTime() };
      publicOk = true;
      logOnce(rt, live, null);
    } catch (e) {
      live.snapshot = nothing();
      publicOk = false;
      logOnce(rt, live, `camera: ${reason(e)}`);
    }
  } else {
    live.snapshot = nothing();
    if (read) logOnce(rt, live, "not printing or not public");
  }
  await watchCamera(rt, live, publicOk, now).catch((e: unknown) => rt.log.warn({ error: reason(e) }, "live: the camera check failed"));
  return read;
}
