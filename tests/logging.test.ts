import { expect, test } from "bun:test";
import { createLogger } from "../src/lib/server/logging";

test("writes structured fields with correlation and event IDs", () => {
  const lines: string[] = [];
  const log = createLogger((line) => lines.push(line));
  log("info", "event accepted", { correlationId: "request-1", eventId: "event-1" });
  expect(JSON.parse(lines[0])).toMatchObject({
    level: "info",
    message: "event accepted",
    correlationId: "request-1",
    eventId: "event-1",
  });
});
