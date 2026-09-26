import { createServer } from "vite";
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
const server = await createServer({
  server: { host: "127.0.0.1", port: config.INTERNAL_PORT, strictPort: true },
});
await server.listen();
log("info", "internal development listener started", { port: config.INTERNAL_PORT });
