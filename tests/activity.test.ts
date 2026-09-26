import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { getActivityFilterOptions, listActivity } from "../src/lib/server/activity";
import { openDatabase } from "../src/lib/server/db";
import { createActionResult } from "../src/lib/server/db/repositories/actionResults";
import { createAttempt } from "../src/lib/server/db/repositories/attempts";
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

describe("Activity query", () => {
  test("returns newest events with their classification, destination, and status", () => {
    const mail = createIntegration(db, { name: "Mail", kind: "mail", config: {} });
    const mailRoute = createEventRoute(db, {
      id: "route-mail",
      eventType: "task.create",
      integrationId: mail.id,
      config: {},
    });
    const omniApp = createIntegration(db, { name: "OmniApp", kind: "omniapp", config: {} });
    const omniRoute = createEventRoute(db, {
      id: "route-omni",
      eventType: "package.detected",
      integrationId: omniApp.id,
      config: {},
    });

    createEvent(db, {
      id: "oldest",
      source: "mail",
      type: "task.create",
      receivedAt: "2026-04-01T08:30:00.000Z",
      text: "Call Sam about the launch",
      payload: { title: "Call Sam" },
    });
    createClassification(db, {
      id: "classification-oldest",
      eventId: "oldest",
      actionType: "task.create",
      result: { action: { type: "task.create" } },
      provider: "typesafe",
      model: "jev-test",
      confidence: 0.92,
      status: "classified",
      error: null,
      createdAt: "2026-04-01T08:31:00.000Z",
    });
    createAttempt(db, {
      id: "attempt-oldest",
      eventId: "oldest",
      stage: "classification",
      status: "succeeded",
      startedAt: "2026-04-01T08:30:01.000Z",
      finishedAt: "2026-04-01T08:31:00.000Z",
    });
    createDelivery(db, {
      id: "delivery-oldest",
      eventId: "oldest",
      integrationId: mail.id,
      routeId: mailRoute.id,
      status: "succeeded",
      idempotencyKey: "delivery-oldest-key",
      request: {},
    });

    createEvent(db, {
      id: "middle",
      source: "pebble",
      type: "package.detected",
      receivedAt: "2026-04-02T09:00:00.000Z",
      payload: { carrier: "UPS", trackingNumber: "1Z999" },
    });
    createClassification(db, {
      id: "classification-middle",
      eventId: "middle",
      actionType: "package.detected",
      result: { action: { type: "package.detected" } },
      provider: "typesafe",
      model: "jev-test",
      confidence: null,
      status: "classified",
      error: null,
      createdAt: "2026-04-02T09:01:00.000Z",
    });
    createDelivery(db, {
      id: "delivery-middle",
      eventId: "middle",
      integrationId: omniApp.id,
      routeId: omniRoute.id,
      status: "pending",
      idempotencyKey: "delivery-middle-key",
      request: {},
    });
    createActionResult(db, {
      id: "old-failure-middle",
      eventId: "middle",
      actionType: "package.detected",
      status: "failed",
      error: "An earlier delivery attempt failed.",
    });

    createEvent(db, {
      id: "review",
      source: "pebble",
      type: "capture",
      receivedAt: "2026-04-03T10:00:00.000Z",
      text: "Maybe turn this into a note",
      payload: { text: "Maybe turn this into a note" },
    });
    createClassification(db, {
      id: "classification-review",
      eventId: "review",
      actionType: "note.create",
      result: { reason: "ambiguous" },
      provider: "typesafe",
      model: "jev-test",
      confidence: 0.42,
      status: "needs_review",
      error: "The action needs review.",
      createdAt: "2026-04-03T10:01:00.000Z",
    });
    createAttempt(db, {
      id: "attempt-review",
      eventId: "review",
      stage: "classification",
      status: "needs_review",
      error: "The action needs review.",
      startedAt: "2026-04-03T10:00:01.000Z",
      finishedAt: "2026-04-03T10:01:00.000Z",
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
      idempotencyKey: "delivery-failed-key",
      request: {},
    });
    createActionResult(db, {
      id: "action-failed",
      eventId: "failed",
      actionType: "task.create",
      status: "failed",
      error: "Mail is unavailable.",
    });

    const events = listActivity(db);

    expect(events.map((event) => event.id)).toEqual(["failed", "review", "middle", "oldest"]);
    expect(events[3]).toMatchObject({
      source: "mail",
      receivedAt: "2026-04-01T08:30:00.000Z",
      summary: "Call Sam about the launch",
      actionType: "task.create",
      confidence: 0.92,
      destination: "Mail",
      routeId: "route-mail",
      status: "succeeded",
      highlight: false,
    });
    expect(events[2]).toMatchObject({
      summary: '{"carrier":"UPS","trackingNumber":"1Z999"}',
      actionType: "package.detected",
      destination: "OmniApp",
      routeId: "route-omni",
      status: "pending",
      error: null,
    });
    expect(events[1]).toMatchObject({
      status: "needs_review",
      highlight: true,
      error: "The action needs review.",
    });
    expect(events[0]).toMatchObject({
      status: "failed",
      highlight: true,
      error: "Mail is unavailable.",
    });
  });

  test("applies source, status, action type, and inclusive date filters", () => {
    createEvent(db, {
      id: "mail-one",
      source: "mail",
      type: "task.create",
      receivedAt: "2026-04-01T23:30:00.000Z",
      text: "First",
      payload: {},
    });
    createEvent(db, {
      id: "pebble-two",
      source: "pebble",
      type: "package.detected",
      receivedAt: "2026-04-02T09:00:00.000Z",
      text: "Second",
      payload: {},
    });
    createClassification(db, {
      eventId: "pebble-two",
      actionType: "package.detected",
      result: {},
      provider: "typesafe",
      model: "jev-test",
      confidence: null,
      status: "needs_review",
      error: null,
    });

    expect(listActivity(db, { source: "mail" }).map((event) => event.id)).toEqual(["mail-one"]);
    expect(listActivity(db, { status: "needs_review" }).map((event) => event.id)).toEqual([
      "pebble-two",
    ]);
    expect(listActivity(db, { actionType: "package.detected" }).map((event) => event.id)).toEqual([
      "pebble-two",
    ]);
    expect(
      listActivity(db, { from: "2026-04-02", to: "2026-04-02" }).map((event) => event.id)
    ).toEqual(["pebble-two"]);
    expect(
      listActivity(db, { from: "2026-04-01", to: "2026-04-01" }).map((event) => event.id)
    ).toEqual(["mail-one"]);
  });

  test("returns sources, event types, classified action types, and statuses for the filters", () => {
    createEvent(db, {
      id: "event",
      source: "pebble",
      type: "capture",
      text: "A capture",
      payload: {},
    });
    createClassification(db, {
      eventId: "event",
      actionType: "note.create",
      result: {},
      provider: "typesafe",
      model: "jev-test",
      confidence: null,
      status: "classified",
      error: null,
    });

    expect(getActivityFilterOptions(db)).toEqual({
      sources: ["pebble"],
      actionTypes: ["capture", "note.create"],
      statuses: [
        "received",
        "processing",
        "pending",
        "succeeded",
        "failed",
        "needs_review",
        "unrouted",
      ],
    });
  });
});
