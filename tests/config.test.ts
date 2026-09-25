import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/lib/server/config";

const validEnvironment = {
  PUBLIC_PORT: "4310",
  INTERNAL_PORT: "4311",
  DATABASE_PATH: "./data/relay.sqlite",
  PEBBLE_WEBHOOK_SECRETS: "first,second",
  INTERNAL_SERVICE_CREDENTIALS: '{"mail":"token"}',
  MODEL_PROVIDER: "openai",
  MODEL_NAME: "configured-model",
  DEFAULT_EXECUTOR: "codex",
  CODEX_EXECUTABLE: "codex",
  CLAUDE_EXECUTABLE: "claude",
};

describe("loadConfig", () => {
  test("parses the listener and service settings", () => {
    const config = loadConfig(validEnvironment);
    expect(config.PUBLIC_PORT).toBe(4310);
    expect(config.PEBBLE_WEBHOOK_SECRETS).toEqual(["first", "second"]);
    expect(config.PEBBLE_MAX_BODY_BYTES).toBe(65_536);
    expect(config.PEBBLE_RATE_LIMIT_PER_MINUTE).toBe(30);
    expect(config.INTERNAL_SERVICE_CREDENTIALS).toEqual({ mail: "token" });
  });

  test("accepts Pebble request limits from the environment", () => {
    const config = loadConfig({
      ...validEnvironment,
      PEBBLE_MAX_BODY_BYTES: "2048",
      PEBBLE_RATE_LIMIT_PER_MINUTE: "12",
    });
    expect(config.PEBBLE_MAX_BODY_BYTES).toBe(2048);
    expect(config.PEBBLE_RATE_LIMIT_PER_MINUTE).toBe(12);
  });

  test("reports missing settings without logging secret values", () => {
    const environment = {
      ...validEnvironment,
      MODEL_NAME: undefined,
      INTERNAL_SERVICE_CREDENTIALS: "private-token",
    };
    expect(() => loadConfig(environment)).toThrow(/MODEL_NAME/);
    expect(() => loadConfig(environment)).toThrow(/INTERNAL_SERVICE_CREDENTIALS/);
    expect(() => loadConfig(environment)).not.toThrow(/private-token/);
  });

  test("rejects a shared listener port", () => {
    expect(() => loadConfig({ ...validEnvironment, INTERNAL_PORT: "4310" })).toThrow(
      /must differ from PUBLIC_PORT/
    );
  });
});
