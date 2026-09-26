import type { Database } from "bun:sqlite";
import { listActionResultsForEvent, type ActionResult } from "./db/repositories/actionResults";
import { listAttemptsForEvent, type ProcessingAttempt } from "./db/repositories/attempts";
import {
  listClassificationsForEvent,
  type Classification,
} from "./db/repositories/classifications";
import { listDeliveriesForEvent, type Delivery } from "./db/repositories/deliveries";
import { getEvent, type IncomingEvent } from "./db/repositories/events";
import {
  getEventRoute,
  getIntegration,
  type EventRoute,
  type Integration,
} from "./db/repositories/integrations";

export interface EventFailure {
  step: string;
  reason: string;
}

export interface EventContextRecord {
  attemptId: string;
  items: Array<{
    eventId: string;
    source: string;
    receivedAt: string;
    text: string | null;
    summary: string;
  }>;
  unresolvedIds: string[];
}

export interface EventRouteRecord {
  deliveryId: string;
  route: EventRoute | null;
  integration: Integration | null;
}

export interface EventDeliveryRecord {
  delivery: Delivery;
  downstreamId: string | null;
}

export interface EventDetail {
  event: IncomingEvent;
  normalizedEvent: {
    id: string;
    source: string;
    sourceEventId: string | null;
    receivedAt: string;
    type: string;
    text: string | null;
    metadata: Record<string, unknown> | null;
  };
  contexts: EventContextRecord[];
  classifications: Classification[];
  attempts: ProcessingAttempt[];
  actionResults: ActionResult[];
  routes: EventRouteRecord[];
  deliveries: EventDeliveryRecord[];
  failedStep: EventFailure | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: unknown, key: string): string | null {
  const field = record(value)?.[key];
  return typeof field === "string" ? field : null;
}

function contextFromAttempt(db: Database, attempt: ProcessingAttempt): EventContextRecord | null {
  const details = record(attempt.details);
  if (!details) return null;
  const ids = details.selectedContextIds;
  if (!Array.isArray(ids)) return null;

  const items: EventContextRecord["items"] = [];
  const unresolvedIds: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const event = getEvent(db, id);
    if (!event) {
      unresolvedIds.push(id);
      continue;
    }
    items.push({
      eventId: event.id,
      source: event.source,
      receivedAt: event.receivedAt,
      text: event.text,
      summary:
        event.text ??
        (typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload)),
    });
  }
  return { attemptId: attempt.id, items, unresolvedIds };
}

function downstreamId(delivery: Delivery, actionResults: ActionResult[]): string | null {
  const fromResponse = stringField(delivery.response, "downstreamId");
  if (fromResponse) return fromResponse;

  const result = [...actionResults]
    .reverse()
    .find((entry) => stringField(entry.result, "deliveryId") === delivery.id);
  return stringField(result?.result, "downstreamId") ?? stringField(result?.result, "id");
}

function latest<T>(items: T[]): T | null {
  return items.at(-1) ?? null;
}

function deriveFailedStep(
  classifications: Classification[],
  attempts: ProcessingAttempt[],
  actionResults: ActionResult[],
  deliveries: Delivery[]
): EventFailure | null {
  const lastAction = latest(actionResults);
  if (lastAction?.status === "unrouted") {
    return {
      step: "Routing",
      reason: lastAction.error ?? "No enabled route matched this event.",
    };
  }
  if (lastAction?.status === "succeeded") return null;

  const failedDelivery = [...deliveries]
    .reverse()
    .find((delivery) => ["failed", "dead"].includes(delivery.status));
  if (failedDelivery) {
    return {
      step: "Delivery",
      reason: failedDelivery.lastError ?? `Delivery status is ${failedDelivery.status}.`,
    };
  }
  if (lastAction?.status === "failed") {
    return { step: "Action", reason: lastAction.error ?? "The recorded action failed." };
  }

  const classification = latest(classifications);
  if (classification && ["failed", "needs_review"].includes(classification.status)) {
    return {
      step: "Classification",
      reason: classification.error ?? `Classification status is ${classification.status}.`,
    };
  }

  const classificationAttempt = [...attempts]
    .reverse()
    .find((attempt) => attempt.stage === "classification");
  if (classificationAttempt && ["failed", "needs_review"].includes(classificationAttempt.status)) {
    return {
      step: "Classification",
      reason:
        classificationAttempt.error ??
        `Classification attempt status is ${classificationAttempt.status}.`,
    };
  }
  return null;
}

/** Load all recorded event history for the read-only admin detail page. */
export function getEventDetail(db: Database, eventId: string): EventDetail | null {
  const event = getEvent(db, eventId);
  if (!event) return null;

  const attempts = listAttemptsForEvent(db, eventId);
  const classifications = listClassificationsForEvent(db, eventId);
  const actionResults = listActionResultsForEvent(db, eventId);
  const deliveries = listDeliveriesForEvent(db, eventId);

  return {
    event,
    normalizedEvent: {
      id: event.id,
      source: event.source,
      sourceEventId: event.sourceEventId,
      receivedAt: event.receivedAt,
      type: event.type,
      text: event.text,
      metadata: event.metadata,
    },
    contexts: attempts
      .filter((attempt) => attempt.stage === "classification")
      .map((attempt) => contextFromAttempt(db, attempt))
      .filter((context): context is EventContextRecord => context !== null),
    classifications,
    attempts,
    actionResults,
    routes: deliveries.map((delivery) => ({
      deliveryId: delivery.id,
      route: delivery.routeId ? getEventRoute(db, delivery.routeId) : null,
      integration: getIntegration(db, delivery.integrationId),
    })),
    deliveries: deliveries.map((delivery) => ({
      delivery,
      downstreamId: downstreamId(delivery, actionResults),
    })),
    failedStep: deriveFailedStep(classifications, attempts, actionResults, deliveries),
  };
}
