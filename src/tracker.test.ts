// The print-bridge's minute against Home Assistant and Invoice Ninja in memory (testing/services.ts).
import { afterEach, describe, expect, it } from "vitest";
import { tick } from "./tracker.ts";
import { testRuntime } from "./testing/runtime.ts";
import { fakeServices, type Printer } from "./testing/services.ts";
import type { Runtime } from "./runtime.ts";

const opened: Runtime[] = [];
afterEach(() => {
  for (const rt of opened.splice(0)) rt.store.close();
});

const IDLE: Printer = { status: "idle", task: "", grams: "0", start: "unknown", end: "unknown" };

function setup(printer: Printer = IDLE, env: Record<string, string> = {}) {
  const rt = testRuntime(env);
  opened.push(rt);
  rt.clock = () => new Date("2026-11-21T09:00:00.000Z");
  const svc = fakeServices(rt, { ...printer });
  return { rt, svc };
}

/** The printer starts `task` at 10:00 Berlin time, then finishes it at 12:13 with 48.6 g. */
const running = (task: string, start = "2026-11-21T09:00:00+00:00"): Printer => ({
  status: "running",
  task,
  grams: "48.6",
  start,
  end: "2026-11-21T11:13:00+00:00",
});
const finished = (task: string, start = "2026-11-21T09:00:00+00:00"): Printer => ({ ...running(task, start), status: "finish" });

async function firstTick(rt: Runtime) {
  await tick(rt); // the first start records what it finds and does nothing else
}

describe("the minute", () => {
  it("marks an approved quote without a Druckstatus as waiting, and leaves the others", async () => {
    const { rt, svc } = setup();
    const a = svc.quote("3D-2026-0010");
    const b = svc.quote("3D-2026-0011", { custom_value2: "fertig" });
    const draft = svc.quote("3D-2026-0012", { status_id: "1" });
    await firstTick(rt);
    expect([a.custom_value2, b.custom_value2, draft.custom_value2]).toEqual(["wartet", "fertig", ""]);
  });

  it("takes a print through to the invoice draft: im Druck, the note, fertig, the invoice, one push", async () => {
    const { rt, svc } = setup();
    const q = svc.quote("3D-2026-0010");
    await firstTick(rt);
    Object.assign(svc.printer, running("3D-2026-0010 Vase"));
    await tick(rt);
    expect(q.custom_value2).toBe("im Druck");
    Object.assign(svc.printer, finished("3D-2026-0010 Vase"));
    await tick(rt);
    expect(q.private_notes).toBe("Request from noticebox: https://inbox.test/x\nGedruckt am 21.11.2026: 3D-2026-0010 Vase, 2 h 13 min, 48,6 g");
    expect(q.status_id).toBe("4");
    const inv = svc.invoices.get(q.invoice_id)!;
    expect(inv).toMatchObject({ status_id: "1", custom_value2: "fertig" });
    expect(svc.pushes).toEqual([
      { title: "Fertig: 3D-2026-0010", message: `Gedruckt (2 h 13 min, 48,6 g). Rechnungsentwurf ${inv.number} ist angelegt: prüfen und senden.` },
    ]);
    await tick(rt);
    expect(svc.pushes).toHaveLength(1);
    expect(q.private_notes.match(/Gedruckt am/g)).toHaveLength(1);
  });

  it("does nothing with the print it finds at its first start", async () => {
    const { rt, svc } = setup(finished("3D-2026-0010 Vase"));
    const q = svc.quote("3D-2026-0010", { custom_value2: "im Druck" });
    await firstTick(rt);
    await tick(rt);
    expect([q.status_id, q.custom_value2, svc.pushes.length]).toEqual(["3", "im Druck", 0]);
  });

  it("assumes the only waiting quote for a print without a number, and says so", async () => {
    const { rt, svc } = setup();
    const q = svc.quote("3D-2026-0010");
    await firstTick(rt);
    Object.assign(svc.printer, running("Vase"));
    await tick(rt);
    expect(q.custom_value2).toBe("im Druck");
    expect(svc.pushes).toEqual([
      { title: "Druck zugeordnet: 3D-2026-0010", message: "„Vase“ hat keine Angebotsnummer im Namen; es wartet nur 3D-2026-0010, also gehört der Druck dazu." },
    ]);
  });

  it("leaves a print alone that fits no quote, or two, and says so once", async () => {
    const { rt, svc } = setup();
    const a = svc.quote("3D-2026-0010");
    const b = svc.quote("3D-2026-0011");
    await firstTick(rt);
    Object.assign(svc.printer, running("Vase"));
    await tick(rt);
    await tick(rt);
    Object.assign(svc.printer, finished("Vase"));
    await tick(rt);
    expect([a.custom_value2, b.custom_value2, a.status_id, b.status_id]).toEqual(["wartet", "wartet", "3", "3"]);
    expect(svc.pushes).toEqual([
      {
        title: "Druck ohne Angebot",
        message:
          "„Vase“ gehört zu keinem Angebot: es warten 2 (3D-2026-0010, 3D-2026-0011). Diesen Druck in Invoice Ninja von Hand eintragen; beim nächsten die Angebotsnummer in den Namen setzen (z. B. „3D-2026-0010 Vase“).",
      },
    ]);
  });

  it("converts only after the last part of a print in parts", async () => {
    const { rt, svc } = setup();
    const q = svc.quote("3D-2026-0010");
    await firstTick(rt);
    Object.assign(svc.printer, finished("3D-2026-0010 Vase (1/2)", "2026-11-21T08:00:00+00:00"));
    await tick(rt);
    expect([q.status_id, q.custom_value2]).toEqual(["3", "im Druck"]);
    expect(svc.pushes.map((p) => p.title)).toEqual(["Teil 1/2 fertig: 3D-2026-0010"]);
    Object.assign(svc.printer, finished("3D-2026-0010 Vase (2/2)"));
    await tick(rt);
    expect([q.status_id, q.custom_value2]).toEqual(["4", "fertig"]);
    expect(q.private_notes.match(/Gedruckt am/g)).toHaveLength(2);
  });

  it("puts a failed print's quote back to waiting, with a push", async () => {
    const { rt, svc } = setup();
    const q = svc.quote("3D-2026-0010");
    await firstTick(rt);
    Object.assign(svc.printer, running("3D-2026-0010 Vase"));
    await tick(rt);
    Object.assign(svc.printer, { ...running("3D-2026-0010 Vase"), status: "failed" });
    await tick(rt);
    expect([q.custom_value2, q.status_id]).toEqual(["wartet", "3"]);
    expect(svc.pushes.map((p) => p.title)).toEqual(["Druck fehlgeschlagen: 3D-2026-0010"]);
  });

  it("finishes a print it never saw running (the bridge was down)", async () => {
    const { rt, svc } = setup();
    const q = svc.quote("3D-2026-0010");
    await firstTick(rt);
    Object.assign(svc.printer, finished("3D-2026-0010 Vase"));
    await tick(rt);
    expect(q.status_id).toBe("4");
  });

  it("does nothing while the printer is off", async () => {
    const { rt, svc } = setup({ status: "unavailable", task: "unavailable", grams: "unavailable", start: "unavailable", end: "unavailable" });
    svc.quote("3D-2026-0010");
    await firstTick(rt);
    await tick(rt);
    expect(svc.pushes).toEqual([]);
  });

  it("tries again next minute when Invoice Ninja is down, without writing anything twice", async () => {
    const { rt, svc } = setup();
    const q = svc.quote("3D-2026-0010");
    await firstTick(rt);
    Object.assign(svc.printer, finished("3D-2026-0010 Vase"));
    svc.failWhen((c) => (c.url.endsWith("/quotes/bulk") ? new Response(null, { status: 503 }) : undefined));
    await tick(rt);
    expect(q.status_id).toBe("3");
    svc.failWhen(() => undefined);
    await tick(rt);
    expect(q.status_id).toBe("4");
    expect(q.private_notes.match(/Gedruckt am/g)).toHaveLength(1);
    expect(svc.pushes.map((p) => p.title)).toEqual(["Fertig: 3D-2026-0010"]);
  });

  it("waits without its tokens", async () => {
    const { rt, svc } = setup(IDLE, { PRINT_HA_TOKEN: "", PRINT_INVOICENINJA_TOKEN: "" });
    await tick(rt);
    expect(svc.calls).toEqual([]);
  });
});
