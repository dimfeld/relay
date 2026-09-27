import { createServer } from "vite";
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
const server = await createServer({
  server: { host: "127.0.0.1", port: config.INTERNAL_PORT, strictPort: true },
});
await server.listen();
// The Vite dev server runs the SvelteKit init hook, which starts the queue workers, on the first
// request. Send one now so captures are processed before anyone opens the admin UI.
await fetch(`http://127.0.0.1:${config.INTERNAL_PORT}/health`);
log("info", "internal development listener started", { port: config.INTERNAL_PORT });
