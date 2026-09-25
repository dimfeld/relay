import { loadConfig, type AppConfig } from "./lib/server/config";
import { log } from "./lib/server/logging";

export function createPublicServer(config: AppConfig, port = config.PUBLIC_PORT) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      const correlationId = crypto.randomUUID();
      log("info", "public request", {
        correlationId,
        method: request.method,
        path: new URL(request.url).pathname,
        status: 404,
      });
      return new Response("Not found", {
        status: 404,
        headers: { "x-correlation-id": correlationId },
      });
    },
  });
}

if (import.meta.main) {
  const config = loadConfig();
  const server = createPublicServer(config);
  log("info", "public listener started", { port: server.port });
}
