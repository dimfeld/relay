import { describe, expect, test } from "bun:test";
import { createProviderAdapters } from "../src/lib/server/classifier/adapters";
import { classifyCapture } from "../src/lib/server/classifier/service";
import { loadClassifierConfig } from "../src/lib/server/config";

// Opt-in check against the real providers. Set RELAY_PROVIDER_TESTS=1 plus both API keys to run it.
const enabled =
  process.env.RELAY_PROVIDER_TESTS === "1" &&
  Boolean(process.env.TYPESAFE_API_KEY && process.env.OPENAI_API_KEY);

describe.skipIf(!enabled)("real Jev and Luna providers", () => {
  test("classifies and extracts a task", async () => {
    const adapters = createProviderAdapters(loadClassifierConfig());
    const result = await classifyCapture(
      {
        text: "Add buy printer filament to my to-do list",
        referenceTime: new Date().toISOString(),
        projects: [],
        context: [],
      },
      adapters
    );
    expect(result).toMatchObject({ status: "classified", action: { type: "task.create" } });
  }, 60_000);
});
