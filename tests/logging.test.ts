import { expect, test } from "bun:test";
import { createLogger } from "../src/lib/server/logging";

test("writes JSON log records with correlation IDs and nested fields", () => {
  const lines: string[] = [];
  const log = createLogger((line) => lines.push(line));
  log("info", "event accepted", { correlationId: "request-1", eventId: "event-1" });
  expect(JSON.parse(lines[0])).toMatchObject({
    timestamp: expect.any(String),
    level: "info",
    message: "event accepted",
    correlationId: "request-1",
    fields: { eventId: "event-1" },
  });
});
