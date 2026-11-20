// The service's log: pino, JSON on stdout, English. Never a token or a print's name.
// PRINT_LOG_LEVEL (pino's levels: debug, info, warn, error, silent) defaults to info.
import pino from "pino";

export const log = pino({ base: { app: "print-bridge" }, level: process.env.PRINT_LOG_LEVEL || "info" });
