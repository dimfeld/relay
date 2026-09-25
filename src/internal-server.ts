import { loadConfig } from "./lib/server/config";
import { log } from "./lib/server/logging";

const config = loadConfig();
process.env.PORT = String(config.INTERNAL_PORT);
process.env.HOST = "127.0.0.1";

const entry = new URL("../build/index.js", import.meta.url);
await import(entry.href);
log("info", "internal listener started", { port: config.INTERNAL_PORT });
