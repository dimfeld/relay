import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { getEventDetail } from "../src/lib/server/event-detail";
import { openDatabase } from "../src/lib/server/db";
import { createAttempt } from "../src/lib/server/db/repositories/attempts";
import { seedEventDetailFixtures } from "./event-detail-fixture";

let db: Database;

beforeEach(() => {
  db = openDatabase(":memory:");
  seedEventDetailFixtures(db);
});

afterEach(() => {
  db.close();
});

describe("event detail query", () => {
  test("follows a Pebble event from raw input through downstream success", () => {
    const detail = getEventDetail(db, "successful-event");

    expect(detail).not.toBeNull();
    expect(detail).toMatchObject({
      event: {
        id: "successful-event",
        source: "pebble",
        payload: { event: { transcription: "Create a task to update the reservoir." } },
      },
      normalizedEvent: {
        type: "capture",
        text: "Create a task to update the reservoir.",
        metadata: { recordedAt: "2026-06-01T08:04:58.000Z", device: "phone" },
      },
      contexts: [
        {
          attemptId: "successful-classification-attempt",
          items: [
            {
              eventId: "context-event",
              source: "pebble",
              receivedAt: "2026-06-01T08:00:00.000Z",
              text: "The reservoir needs to be removable.",
              summary: "The reservoir needs to be removable.",
            },
          ],
          unresolvedIds: [],
        },
      ],
      classifications: [{ id: "successful-classification", actionType: "task.create" }],
      attempts: [{ id: "successful-classification-attempt", status: "succeeded" }],
      actionResults: [{ id: "successful-action-result", status: "succeeded" }],
      routes: [
        {
          deliveryId: "successful-delivery",
          route: { id: "mail-task-route", actionType: "task.create" },
          integration: { name: "Mail" },
        },
      ],
      deliveries: [
        {
          delivery: { id: "successful-delivery", status: "succeeded" },
          downstreamId: "mail-task-81",
        },
      ],
      failedStep: null,
    });
  });

  test("explains a dead-lettered destination delivery", () => {
    const detail = getEventDetail(db, "failed-event");

    expect(detail?.deliveries[0]?.delivery.status).toBe("dead");
    expect(detail?.failedStep).toEqual({
      step: "Delivery",
      reason: "Mail returned HTTP 503 after the final attempt.",
    });
  });

  test("returns null for an unknown event ID", () => {
    expect(getEventDetail(db, "missing-event")).toBeNull();
  });

  test("keeps selected context IDs visible when their source event is missing", () => {
    createAttempt(db, {
      eventId: "successful-event",
      stage: "classification",
      status: "failed",
      details: { selectedContextIds: ["missing-context-event"] },
    });

    expect(getEventDetail(db, "successful-event")?.contexts.at(-1)).toMatchObject({
      items: [],
      unresolvedIds: ["missing-context-event"],
    });
  });
});
