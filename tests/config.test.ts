import { describe, expect, test } from "bun:test";
import { loadClassifierConfig, loadConfig } from "../src/lib/server/config";

const validEnvironment = {
  PUBLIC_PORT: "4310",
  INTERNAL_PORT: "4311",
  DATABASE_PATH: "./data/relay.sqlite",
  PEBBLE_WEBHOOK_SECRETS: "first,second",
  INTERNAL_SERVICE_CREDENTIALS: '{"mail":{"token":"token","capabilities":["events:publish"]}}',
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
    expect(config.INTERNAL_SERVICE_CREDENTIALS).toEqual({
      mail: { token: "token", capabilities: ["events:publish"] },
    });
    expect(config.INTERNAL_API_MAX_BODY_BYTES).toBe(65_536);
    expect(config.DELIVERY_MAX_ATTEMPTS).toBe(10);
  });

  test("rejects services that share a token", () => {
    const environment = {
      ...validEnvironment,
      INTERNAL_SERVICE_CREDENTIALS: JSON.stringify({
        mail: { token: "shared-token", capabilities: ["events:publish"] },
        omniapp: { token: "shared-token", capabilities: ["events:publish"] },
      }),
    };
    expect(() => loadConfig(environment)).toThrow(/distinct token/);
    expect(() => loadConfig(environment)).not.toThrow(/shared-token/);
  });

  test("rejects unknown capabilities", () => {
    const environment = {
      ...validEnvironment,
      INTERNAL_SERVICE_CREDENTIALS: '{"mail":{"token":"token","capabilities":["root"]}}',
    };
    expect(() => loadConfig(environment)).toThrow(/INTERNAL_SERVICE_CREDENTIALS/);
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
      DEFAULT_EXECUTOR: undefined,
      INTERNAL_SERVICE_CREDENTIALS: "private-token",
    };
    expect(() => loadConfig(environment)).toThrow(/DEFAULT_EXECUTOR/);
    expect(() => loadConfig(environment)).toThrow(/INTERNAL_SERVICE_CREDENTIALS/);
    expect(() => loadConfig(environment)).not.toThrow(/private-token/);
  });

  test("rejects a shared listener port", () => {
    expect(() => loadConfig({ ...validEnvironment, INTERNAL_PORT: "4310" })).toThrow(
      /must differ from PUBLIC_PORT/
    );
  });
});

describe("loadClassifierConfig", () => {
  test("requires both provider keys and defaults the model IDs", () => {
    const config = loadClassifierConfig({ TYPESAFE_API_KEY: "ts-key", OPENAI_API_KEY: "oa-key" });
    expect(config.JEV_MODEL).toBe("jev-latest");
    expect(config.LUNA_MODEL).toBe("gpt-6-luna");
    expect(config.CLASSIFIER_CONTEXT_LIMIT).toBe(10);
    expect(config.CLASSIFIER_CONTEXT_MAX_AGE_MINUTES).toBe(15);
  });

  test("accepts classifier context limits from the environment", () => {
    const config = loadClassifierConfig({
      TYPESAFE_API_KEY: "ts-key",
      OPENAI_API_KEY: "oa-key",
      CLASSIFIER_CONTEXT_LIMIT: "4",
      CLASSIFIER_CONTEXT_MAX_AGE_MINUTES: "8",
    });
    expect(config.CLASSIFIER_CONTEXT_LIMIT).toBe(4);
    expect(config.CLASSIFIER_CONTEXT_MAX_AGE_MINUTES).toBe(8);
  });

  test("reports missing keys without other settings", () => {
    expect(() => loadClassifierConfig({ OPENAI_API_KEY: "oa-key" })).toThrow(/TYPESAFE_API_KEY/);
    expect(() => loadClassifierConfig({ TYPESAFE_API_KEY: "ts-key" })).toThrow(/OPENAI_API_KEY/);
  });

  test("does not require provider keys for the listener configuration", () => {
    expect(loadConfig(validEnvironment)).not.toHaveProperty("OPENAI_API_KEY");
  });
});
