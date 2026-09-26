import { expect, test } from "bun:test";
import { openDatabase } from "../src/lib/server/db";
import { loadConfig } from "../src/lib/server/config";
import { createPublicServer } from "../src/public-webhook-server";

test("public listener does not serve internal paths", async () => {
  const config = loadConfig({
    PUBLIC_PORT: "4310",
    INTERNAL_PORT: "4311",
    DATABASE_PATH: "./data/relay.sqlite",
    PEBBLE_WEBHOOK_SECRETS: "secret",
    INTERNAL_SERVICE_CREDENTIALS: '{"mail":{"token":"token","capabilities":["events:publish"]}}',
    DEFAULT_EXECUTOR: "codex",
    CODEX_EXECUTABLE: "codex",
    CLAUDE_EXECUTABLE: "claude",
  });
  const db = openDatabase(":memory:");
  const server = createPublicServer(config, db, 0);
  try {
    const internalApiPaths = [
      "/api/events",
      "/api/events/event-1",
      "/api/attempts",
      "/api/deliveries",
      "/api/executions",
      "/api/projects",
      "/activity",
    ];
    for (const path of ["/webhooks/pebble", "/health", "/admin", ...internalApiPaths]) {
      const response = await fetch(new URL(path, server.url), {
        headers: { authorization: "Bearer token" },
      });
      expect(response.status).toBe(404);
    }

    const publish = await fetch(new URL("/api/events", server.url), {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ source: "mail", type: "package.detected", payload: {} }),
    });
    expect(publish.status).toBe(404);
  } finally {
    await server.stop();
    db.close();
  }
});
