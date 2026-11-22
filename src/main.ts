// The process: reads the settings (a wrong one stops the start, naming it), opens print-bridge.sqlite, runs the minute (tracker.ts) at
// start and then every 60 s, sends the public colour list (colors.ts) every five minutes, and answers GET /health on PORT. SIGTERM stops the timer and closes the database.
import { createServer } from "node:http";
import { COLORS_EVERY_MS, syncColors } from "./colors.ts";
import { loadConfig } from "./config.ts";
import { log } from "./log.ts";
import { openRuntime } from "./runtime.ts";
import { handle } from "./server.ts";
import { tick } from "./tracker.ts";

const config = loadConfig(process.env);
const rt = openRuntime(config);

let busy = false;
const minute = () => {
  if (busy) return;
  busy = true;
  void tick(rt).finally(() => (busy = false));
};
minute();
const timer = setInterval(minute, 60_000);

let sending = false;
const sendColors = () => {
  if (sending) return;
  sending = true;
  void syncColors(rt).finally(() => (sending = false));
};
sendColors();
const colorsTimer = setInterval(sendColors, COLORS_EVERY_MS);

const server = createServer((req, res) => {
  let path = "/";
  try {
    path = new URL(req.url ?? "/", "http://print-bridge.invalid").pathname;
  } catch {
    // a broken request line answers 404 below
  }
  const r = handle(rt, req.method ?? "GET", path);
  res.writeHead(r.status, { "content-type": "application/json" });
  res.end(r.body === null ? undefined : JSON.stringify(r.body));
});
server.listen(config.port, () => log.info({ port: config.port }, "print-bridge started"));

process.on("uncaughtException", (e) => log.error({ error: e.name }, "uncaught exception"));
process.on("SIGTERM", () => {
  clearInterval(timer);
  clearInterval(colorsTimer);
  server.close(() => {
    rt.store.close();
    process.exit(0);
  });
});
