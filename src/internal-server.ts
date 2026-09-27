import { loadConfig } from "./lib/server/config";
import { openDatabase } from "./lib/server/db";
import { log } from "./lib/server/logging";
import { syncConfiguredCatalogs } from "./lib/server/context";

const config = loadConfig();
const database = openDatabase(config.DATABASE_PATH);
try {
  // Fail at startup, not on the first request, when a configuration file is not valid.
  syncConfiguredCatalogs(database, config);
} finally {
  database.close();
}
process.env.PORT = String(config.INTERNAL_PORT);
process.env.HOST = "127.0.0.1";

const entry = new URL("../build/index.js", import.meta.url);
await import(entry.href);
log("info", "internal listener started", { port: config.INTERNAL_PORT });
