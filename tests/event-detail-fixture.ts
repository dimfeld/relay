import type { Database } from "bun:sqlite";
import { createActionResult } from "../src/lib/server/db/repositories/actionResults";
import { createAttempt } from "../src/lib/server/db/repositories/attempts";
import { createClassification } from "../src/lib/server/db/repositories/classifications";
import { createDelivery, updateDelivery } from "../src/lib/server/db/repositories/deliveries";
import { createEvent } from "../src/lib/server/db/repositories/events";
import {
  createEventRoute,
  createIntegration,
} from "../src/lib/server/db/repositories/integrations";

export function seedEventDetailFixtures(db: Database): void {
  const mail = createIntegration(db, { id: "mail", name: "Mail", kind: "mail", config: {} });
  const route = createEventRoute(db, {
    id: "mail-task-route",
    actionType: "task.create",
    integrationId: mail.id,
    config: {},
  });

  createEvent(db, {
    id: "context-event",
    source: "pebble",
    type: "capture",
    receivedAt: "2026-06-01T08:00:00.000Z",
    text: "The reservoir needs to be removable.",
    payload: { transcription: "The reservoir needs to be removable." },
  });

  createEvent(db, {
    id: "successful-event",
    source: "pebble",
    type: "capture",
    receivedAt: "2026-06-01T08:05:00.000Z",
    text: "Create a task to update the reservoir.",
    payload: { event: { transcription: "Create a task to update the reservoir." } },
    metadata: { recordedAt: "2026-06-01T08:04:58.000Z", device: "phone" },
  });
  createAttempt(db, {
    id: "successful-classification-attempt",
    eventId: "successful-event",
    stage: "classification",
    status: "succeeded",
    startedAt: "2026-06-01T08:05:01.000Z",
    finishedAt: "2026-06-01T08:05:02.000Z",
    details: { selectedContextIds: ["context-event"] },
  });
  createClassification(db, {
    id: "successful-classification",
    eventId: "successful-event",
    actionType: "task.create",
    result: { action: { type: "task.create", title: "Update the reservoir" } },
    provider: "typesafe",
    model: "jev-test",
    confidence: 0.96,
    status: "classified",
    error: null,
    createdAt: "2026-06-01T08:05:02.000Z",
  });
  const successfulDelivery = createDelivery(db, {
    id: "successful-delivery",
    eventId: "successful-event",
    integrationId: mail.id,
    routeId: route.id,
    status: "succeeded",
    attempts: 1,
    idempotencyKey: "successful-event-key",
    request: { actionType: "task.create", payload: { title: "Update the reservoir" } },
  });
  updateDelivery(db, successfulDelivery.id, {
    response: {
      status: 201,
      body: { id: "mail-task-81" },
      bodyTruncated: false,
      downstreamId: "mail-task-81",
    },
  });
  createActionResult(db, {
    id: "successful-action-result",
    eventId: "successful-event",
    actionType: "task.create",
    status: "succeeded",
    result: {
      deliveryId: successfulDelivery.id,
      routeId: route.id,
      downstreamId: "mail-task-81",
    },
    createdAt: "2026-06-01T08:05:03.000Z",
  });

  createEvent(db, {
    id: "failed-event",
    source: "pebble",
    type: "capture",
    receivedAt: "2026-06-01T08:10:00.000Z",
    text: "Send the final agenda to Sam.",
    payload: { transcription: "Send the final agenda to Sam." },
  });
  createAttempt(db, {
    id: "failed-classification-attempt",
    eventId: "failed-event",
    stage: "classification",
    status: "succeeded",
    startedAt: "2026-06-01T08:10:01.000Z",
    finishedAt: "2026-06-01T08:10:02.000Z",
  });
  createClassification(db, {
    id: "failed-classification",
    eventId: "failed-event",
    actionType: "task.create",
    result: { action: { type: "task.create", title: "Send the final agenda" } },
    provider: "typesafe",
    model: "jev-test",
    confidence: 0.91,
    status: "classified",
    error: null,
    createdAt: "2026-06-01T08:10:02.000Z",
  });
  const failedDelivery = createDelivery(db, {
    id: "failed-delivery",
    eventId: "failed-event",
    integrationId: mail.id,
    routeId: route.id,
    status: "dead",
    attempts: 3,
    idempotencyKey: "failed-event-key",
    request: { actionType: "task.create", payload: { title: "Send the final agenda" } },
  });
  updateDelivery(db, failedDelivery.id, {
    lastError: "Mail returned HTTP 503 after the final attempt.",
    response: {
      status: 503,
      body: { error: "Service unavailable" },
      bodyTruncated: false,
      downstreamId: null,
    },
  });
  createActionResult(db, {
    id: "failed-action-result",
    eventId: "failed-event",
    actionType: "task.create",
    status: "failed",
    result: { deliveryId: failedDelivery.id, routeId: route.id },
    error: "Mail returned HTTP 503 after the final attempt.",
    createdAt: "2026-06-01T08:10:05.000Z",
  });
}
