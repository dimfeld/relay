import { loadConfig } from "./lib/server/config";
import { openDatabase } from "./lib/server/db";
import { log } from "./lib/server/logging";
import { loadProjectDefinitions } from "./lib/server/projects/config";
import { syncProjectCatalog } from "./lib/server/projects/catalog";

const config = loadConfig();
const database = openDatabase(config.DATABASE_PATH);
try {
  const projects = loadProjectDefinitions(config.PROJECTS_CONFIG_PATH);
  if (projects) syncProjectCatalog(database, projects, config.DEFAULT_EXECUTOR);
} finally {
  database.close();
}
process.env.PORT = String(config.INTERNAL_PORT);
process.env.HOST = "127.0.0.1";

const entry = new URL("../build/index.js", import.meta.url);
await import(entry.href);
log("info", "internal listener started", { port: config.INTERNAL_PORT });
