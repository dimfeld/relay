import { expect, test } from "bun:test";
import { loadConfig } from "../src/lib/server/config";
import { createPublicServer } from "../src/public-webhook-server";

test("public listener does not serve internal paths", async () => {
  const config = loadConfig({
    PUBLIC_PORT: "4310",
    INTERNAL_PORT: "4311",
    DATABASE_PATH: "./data/relay.sqlite",
    PEBBLE_WEBHOOK_SECRETS: "secret",
    INTERNAL_SERVICE_CREDENTIALS: '{"mail":"token"}',
    MODEL_PROVIDER: "openai",
    MODEL_NAME: "configured-model",
    DEFAULT_EXECUTOR: "codex",
    CODEX_EXECUTABLE: "codex",
    CLAUDE_EXECUTABLE: "claude",
  });
  const server = createPublicServer(config, 0);
  try {
    for (const path of ["/health", "/admin", "/api/events"]) {
      const response = await fetch(new URL(path, server.url));
      expect(response.status).toBe(404);
    }
  } finally {
    await server.stop();
  }
});
