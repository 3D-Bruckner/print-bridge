// The print-bridge's settings, read once at start. The Bambuddy key and the Invoice Ninja token may be missing: then the bridge waits (design P8), so it can be
// deployed before they exist. A wrong value stops the start, naming every such variable. VARIABLES names every variable read anywhere;
// .env.example lists exactly those (config.test.ts).
import * as z from "zod";

export type Config = {
  /** PRINT_BAMBUDDY_URL, PRINT_BAMBUDDY_KEY: Bambuddy and an API key that may read its archive. */
  bambuddy: { url: string; key: string | null };
  /** PRINT_INVOICENINJA_URL, PRINT_INVOICENINJA_TOKEN: Invoice Ninja and a token of a user allowed quotes and invoices. */
  invoiceNinja: { url: string; token: string | null };
  /** PRINT_NTFY_URL: the topic Marcel's pushes go to. */
  ntfyUrl?: string;
  /** PRINT_QUOTE_PATTERN: a quote's number as it appears in a print's name. */
  quotePattern: RegExp;
  dataDir: string;
  port: number;
};

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const url = (name: string) => z.preprocess(blank, z.url({ protocol: /^https?$/, error: `${name} must be an http(s) URL` }));
const optional = z.preprocess(blank, z.string().trim().optional());

const schema = z.object({
  PRINT_BAMBUDDY_URL: url("PRINT_BAMBUDDY_URL"),
  PRINT_BAMBUDDY_KEY: optional,
  PRINT_INVOICENINJA_URL: url("PRINT_INVOICENINJA_URL"),
  PRINT_INVOICENINJA_TOKEN: optional,
  PRINT_NTFY_URL: z.preprocess(blank, z.url({ protocol: /^https?$/, error: "PRINT_NTFY_URL must be an http(s) URL" }).optional()),
  PRINT_QUOTE_PATTERN: optional,
  DATA_DIR: optional,
  PORT: z.preprocess(blank, z.coerce.number({ error: "PORT must be a port number" }).int().min(1).max(65535).optional()),
});

export const VARIABLES: Record<string, string> = {
  ...Object.fromEntries(Object.keys(schema.shape).map((k) => [k, "loadConfig"])),
  PRINT_LOG_LEVEL: "src/log.ts",
  TZ: "Node",
  NODE_EXTRA_CA_CERTS: "Node",
  PUID: "docker-entrypoint.mjs",
  PGID: "docker-entrypoint.mjs",
};

const trim = (u: string) => u.replace(/\/+$/, "");

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  const e = parsed.data;
  let quotePattern: RegExp;
  try {
    quotePattern = new RegExp(e.PRINT_QUOTE_PATTERN ?? "\\b3D-\\d{4}-\\d{4}\\b");
  } catch {
    throw new Error("PRINT_QUOTE_PATTERN must be a regular expression");
  }
  const config: Config = {
    bambuddy: { url: trim(e.PRINT_BAMBUDDY_URL), key: e.PRINT_BAMBUDDY_KEY ?? null },
    invoiceNinja: { url: trim(e.PRINT_INVOICENINJA_URL), token: e.PRINT_INVOICENINJA_TOKEN ?? null },
    quotePattern,
    dataDir: e.DATA_DIR ?? "/data",
    port: e.PORT ?? 8080,
  };
  if (e.PRINT_NTFY_URL) config.ntfyUrl = e.PRINT_NTFY_URL;
  return config;
}

/** Whether both tokens are there; without them the bridge waits. */
export const configured = (c: Config): boolean => Boolean(c.bambuddy.key && c.invoiceNinja.token);
