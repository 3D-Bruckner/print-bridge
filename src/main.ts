// The process: reads the settings (a wrong one stops the start, naming it), opens print-bridge.sqlite, runs the minute (tracker.ts), the live
// round every 3 s (live.ts) and the inventory every five minutes (inventory.ts), each on its own so one can't hold up another, and answers
// HTTP on PORT (server.ts). SIGTERM stops the timers and closes the database.
import { createServer } from "node:http";
import { adoptOldState } from "./adopt.ts";
import { loadConfig } from "./config.ts";
import { INVENTORY_EVERY_MS, refreshInventory } from "./inventory.ts";
import { createLive, LIVE_EVERY_MS, liveRound } from "./live.ts";
import { log } from "./log.ts";
import { openRuntime } from "./runtime.ts";
import { handle, MAX_BODY_BYTES, type Jobs } from "./server.ts";
import { tick } from "./tracker.ts";

const config = loadConfig(process.env);
const rt = openRuntime(config);
const live = createLive(rt);
adoptOldState(rt, live);
const jobs: Jobs = { startedAt: rt.clock().getTime(), live: null, inventory: null };

/** Runs `job` now and every `ms`, never twice at once. */
function every(ms: number, job: () => Promise<unknown>): NodeJS.Timeout {
  let busy = false;
  const run = () => {
    if (busy) return;
    busy = true;
    void job()
      .catch((e: unknown) => log.error({ error: e instanceof Error ? e.message : "error" }, "a job failed"))
      .finally(() => (busy = false));
  };
  run();
  return setInterval(run, ms);
}

const timers = [
  every(60_000, () => tick(rt)),
  every(LIVE_EVERY_MS, async () => {
    if (await liveRound(rt, live)) jobs.live = rt.clock().getTime();
  }),
  every(INVENTORY_EVERY_MS, async () => {
    if (await refreshInventory(rt)) jobs.inventory = rt.clock().getTime();
  }),
];

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) {
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () => {
    if (res.writableEnded) return;
    let path = "/";
    try {
      path = new URL(req.url ?? "/", "http://print-bridge.invalid").pathname;
    } catch {
      // a broken request line answers 404
    }
    const header = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const a = handle(rt, live, jobs, { method: req.method ?? "GET", path, header, body: Buffer.concat(chunks) });
    res.writeHead(a.status, a.headers);
    res.end(a.body ?? undefined);
  });
});
server.listen(config.port, () => log.info({ port: config.port }, "print-bridge started"));

process.on("uncaughtException", (e) => log.error({ error: e.name }, "uncaught exception"));
process.on("SIGTERM", () => {
  timers.forEach(clearInterval);
  server.close(() => {
    rt.store.close();
    process.exit(0);
  });
  server.closeAllConnections();
});
