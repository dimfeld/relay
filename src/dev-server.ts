import { createServer } from "vite";
import { loadConfig } from "./lib/server/config";
import { log } from "./lib/server/logging";

const config = loadConfig();
const server = await createServer({
  server: { host: "127.0.0.1", port: config.INTERNAL_PORT, strictPort: true },
});
await server.listen();
log("info", "internal development listener started", { port: config.INTERNAL_PORT });
