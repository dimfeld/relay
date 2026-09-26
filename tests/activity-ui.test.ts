import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { render } from "svelte/server";
import ActivityView from "../src/lib/components/ActivityView.svelte";
import { getActivityFilterOptions, listActivity } from "../src/lib/server/activity";
import { openDatabase } from "../src/lib/server/db";
import { createActionResult } from "../src/lib/server/db/repositories/actionResults";
import { createClassification } from "../src/lib/server/db/repositories/classifications";
import { createDelivery } from "../src/lib/server/db/repositories/deliveries";
import { createEvent } from "../src/lib/server/db/repositories/events";
import {
  createEventRoute,
  createIntegration,
} from "../src/lib/server/db/repositories/integrations";

let db: Database;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function seedActivity(db: Database) {
  const mail = createIntegration(db, { name: "Mail", kind: "mail", config: {} });
  const mailRoute = createEventRoute(db, {
    id: "mail-route",
    eventType: "task.create",
    integrationId: mail.id,
    config: {},
  });

  createEvent(db, {
    id: "succeeded",
    source: "mail",
    type: "task.create",
    receivedAt: "2026-04-01T08:30:00.000Z",
    text: "Call Sam about the launch",
    payload: { title: "Call Sam" },
  });
  createClassification(db, {
    id: "classification-succeeded",
    eventId: "succeeded",
    actionType: "task.create",
    result: { action: { type: "task.create" } },
    provider: "typesafe",
    model: "jev-test",
    confidence: 0.92,
    status: "classified",
    error: null,
    createdAt: "2026-04-01T08:31:00.000Z",
  });
  createDelivery(db, {
    id: "delivery-succeeded",
    eventId: "succeeded",
    integrationId: mail.id,
    routeId: mailRoute.id,
    status: "succeeded",
    idempotencyKey: "succeeded-key",
    request: {},
  });

  createEvent(db, {
    id: "needs-review",
    source: "pebble",
    type: "capture",
    receivedAt: "2026-04-03T10:00:00.000Z",
    text: "Maybe turn this into a note",
    payload: { text: "Maybe turn this into a note" },
  });
  createClassification(db, {
    id: "classification-review",
    eventId: "needs-review",
    actionType: "note.create",
    result: { reason: "ambiguous" },
    provider: "typesafe",
    model: "jev-test",
    confidence: 0.42,
    status: "needs_review",
    error: "The action needs review.",
    createdAt: "2026-04-03T10:01:00.000Z",
  });

  createEvent(db, {
    id: "failed",
    source: "mail",
    type: "task.create",
    receivedAt: "2026-04-04T11:00:00.000Z",
    text: "Schedule the review",
    payload: { title: "Review" },
  });
  createDelivery(db, {
    id: "delivery-failed",
    eventId: "failed",
    integrationId: mail.id,
    routeId: mailRoute.id,
    status: "dead",
    idempotencyKey: "failed-key",
    request: {},
  });
  createActionResult(db, {
    id: "action-failed",
    eventId: "failed",
    actionType: "task.create",
    status: "failed",
    error: "Mail is unavailable.",
  });
}

describe("Activity view", () => {
  test("renders fixture rows, filters, problem markers, and empty results", () => {
    seedActivity(db);
    const options = getActivityFilterOptions(db);
    const events = listActivity(db);
    const { body } = render(ActivityView, { props: { events, options } });
    const eventRows = body.match(/<tr class="[^"]*">.*?<\/tr>/g) ?? [];

    expect(eventRows).toHaveLength(3);
    expect(eventRows[0]).toContain(">mail</td>");
    expect(eventRows[0]).toContain("2026-04-04T11:00:00.000Z");
    expect(eventRows[0]).toContain("Schedule the review");
    expect(eventRows[0]).toContain('href="/activity/failed"');
    expect(eventRows[0]).toContain("<span>task.create</span>");
    expect(eventRows[0]).toContain(">Mail");
    expect(eventRows[0]).toContain(">failed</span>");
    expect(eventRows[0]).toContain("Mail is unavailable.");
    expect(eventRows[0]).toMatch(/class="[^"]*\battention\b/);
    expect(eventRows[0]).toMatch(/class="[^"]*\bproblem\b/);

    expect(eventRows[1]).toContain(">pebble</td>");
    expect(eventRows[1]).toContain("2026-04-03T10:00:00.000Z");
    expect(eventRows[1]).toContain("Maybe turn this into a note");
    expect(eventRows[1]).toContain("<span>note.create</span>");
    expect(eventRows[1]).toContain("needs review");
    expect(eventRows[1]).toContain("The action needs review.");
    expect(eventRows[1]).toMatch(/class="[^"]*\battention\b/);
    expect(eventRows[1]).toMatch(/class="[^"]*\bproblem\b/);

    expect(eventRows[2]).toContain(">mail</td>");
    expect(eventRows[2]).toContain("2026-04-01T08:30:00.000Z");
    expect(eventRows[2]).toContain("Call Sam about the launch");
    expect(eventRows[2]).toContain("<span>task.create</span>");
    expect(eventRows[2]).toContain(">Mail");
    expect(eventRows[2]).toContain("succeeded");
    expect(eventRows[2]).toContain("92% confidence");

    expect(body).toContain('<option value="mail">mail</option>');
    expect(body).toContain('<option value="pebble">pebble</option>');
    expect(body).toContain('<option value="failed">failed</option>');
    expect(body).toContain('<option value="needs_review">needs review</option>');
    expect(body).toContain('<option value="task.create">task.create</option>');
    expect(body).toContain('<option value="note.create">note.create</option>');
    expect(body.match(/type="date"/g)).toHaveLength(2);

    const failedEvents = listActivity(db, { status: "failed" });
    const failedBody = render(ActivityView, { props: { events: failedEvents, options } }).body;
    expect(failedBody).toContain("Schedule the review");
    expect(failedBody).not.toContain("Maybe turn this into a note");
    expect(failedBody).not.toContain("Call Sam about the launch");

    const emptyEvents = listActivity(db, { source: "missing" });
    const emptyBody = render(ActivityView, { props: { events: emptyEvents, options } }).body;
    expect(emptyBody).toContain("No events match these filters.");
  });
});
