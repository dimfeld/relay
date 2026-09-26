import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { render } from "svelte/server";
import FailuresView from "../src/lib/components/FailuresView.svelte";
import { openDatabase } from "../src/lib/server/db";
import { createDelivery, updateDelivery } from "../src/lib/server/db/repositories/deliveries";
import { createEvent } from "../src/lib/server/db/repositories/events";
import { createIntegration } from "../src/lib/server/db/repositories/integrations";
import { claimJob, enqueueJob, failJob } from "../src/lib/server/db/repositories/jobs";
import { listFailures } from "../src/lib/server/failures";

let db: Database;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

const retry = async () => {};

function seedFailures() {
  createEvent(db, { id: "capture-1", source: "pebble", type: "pebble.transcription", payload: {} });
  enqueueJob(db, {
    type: "classify",
    queue: "classification",
    payload: { eventId: "capture-1" },
    eventId: "capture-1",
    maxAttempts: 3,
  });
  const job = claimJob(db, "worker", undefined, "classification")!;
  failJob(db, job.id, "worker", "Jev is unavailable.", undefined, false);

  const mail = createIntegration(db, { name: "Mail", kind: "mail", config: {} });
  createEvent(db, { id: "capture-2", source: "pebble", type: "pebble.transcription", payload: {} });
  const delivery = createDelivery(db, {
    id: "delivery-1",
    eventId: "capture-2",
    integrationId: mail.id,
    idempotencyKey: "key-1",
    request: { actionType: "task.create" },
  });
  updateDelivery(db, delivery.id, {
    status: "dead",
    attempts: 10,
    lastError: "Mail returned HTTP 503.",
  });
}

describe("failures view", () => {
  test("renders failed classifications and dead deliveries with retry buttons", () => {
    seedFailures();
    const { body } = render(FailuresView, { props: { failures: listFailures(db), retry } });
    const rows = body.match(/<tr[^>]*>.*?<\/tr>/gs) ?? [];
    const dataRows = rows.filter((row) => row.includes("<td"));

    expect(dataRows).toHaveLength(2);
    expect(dataRows[0]).toContain('href="/activity/capture-1"');
    expect(dataRows[0]).toContain("pebble.transcription");
    expect(dataRows[0]).toContain("Jev is unavailable.");
    expect(dataRows[0]).toContain(">Retry</button>");

    expect(dataRows[1]).toContain('href="/activity/capture-2"');
    expect(dataRows[1]).toContain("task.create");
    expect(dataRows[1]).toContain(">Mail</td>");
    expect(dataRows[1]).toContain(">10</td>");
    expect(dataRows[1]).toContain("Mail returned HTTP 503.");
    expect(dataRows[1]).toContain(">Retry</button>");
  });

  test("renders empty groups", () => {
    const { body } = render(FailuresView, { props: { failures: listFailures(db), retry } });
    expect(body).toContain("No failed classifications.");
    expect(body).toContain("No dead deliveries.");
  });
});
