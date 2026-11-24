// What the two services this bridge replaced left behind: printer-live's hide switch (visibility.json) and the receiver's last colour list
// (colors.json), when the migration put them in DATA_DIR. Taken over once; the files are then renamed. An unreadable switch means hidden.
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { adoptColors, publicColors } from "./inventory.ts";
import { adoptHidden, type Live } from "./live.ts";
import type { Runtime } from "./runtime.ts";

export function adoptOldState(rt: Runtime, live: Live): void {
  const visibility = join(rt.config.dataDir, "visibility.json");
  if (existsSync(visibility)) {
    let hidden = true;
    try {
      const value = (JSON.parse(readFileSync(visibility, "utf8")) as { hidden?: unknown }).hidden;
      if (typeof value === "boolean") hidden = value;
    } catch {
      // stays hidden
    }
    adoptHidden(rt, live, hidden);
    renameSync(visibility, `${visibility}.adopted`);
  }
  const colors = join(rt.config.dataDir, "colors.json");
  if (existsSync(colors)) {
    try {
      const list = (JSON.parse(readFileSync(colors, "utf8")) as { colors?: unknown }).colors;
      if (Array.isArray(list)) {
        const spools = (list as { name?: unknown; finish?: unknown; material?: unknown; rgba?: unknown }[]).map((c) => ({
          color_name: c.name,
          subtype: c.finish,
          material: c.material,
          rgba: c.rgba,
        }));
        adoptColors(rt, publicColors(spools));
      }
    } catch {
      rt.log.warn("print-bridge: the old colour list couldn't be read");
    }
    renameSync(colors, `${colors}.adopted`);
  }
}
