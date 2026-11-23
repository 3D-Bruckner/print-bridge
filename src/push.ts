// A push to Marcel through ntfy (PRINT_NTFY_URL, a topic whose name is the secret): a print done, a part done, a print failed or
// without a quote, the bridge stuck. Its text names quote and invoice numbers, times and grams, never a person or a print's name. Without
// a topic nothing is sent (logged once); a failed push is logged and never in the way.
import type { Runtime } from "./runtime.ts";

const told = new WeakSet<object>();

/** True when ntfy took it. */
export async function push(
  rt: Runtime,
  p: { title: string; message: string; click?: string; priority?: 1 | 2 | 3 | 4 | 5; tags?: string; url?: string | undefined },
): Promise<boolean> {
  const url = p.url ?? rt.config.ntfyUrl;
  if (!url) {
    if (!told.has(rt.store)) {
      told.add(rt.store);
      rt.log.info("push: no PRINT_NTFY_URL, so pushes are in the log only");
    }
    return false;
  }
  const headers: Record<string, string> = { Title: p.title, Priority: String(p.priority ?? 4) };
  if (p.click) headers.Click = p.click;
  if (p.tags) headers.Tags = p.tags;
  try {
    const r = await rt.fetch(url, { method: "POST", headers, body: p.message, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) rt.log.warn({ status: r.status }, "push: ntfy refused");
    return r.ok;
  } catch (e) {
    rt.log.warn({ error: e instanceof Error ? e.name : "error" }, "push: ntfy unreachable");
    return false;
  }
}
