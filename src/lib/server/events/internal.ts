import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { ServiceCapability } from "../config";
import { createEvent, findEventBySource } from "../db/repositories/events";
import { enqueueJob } from "../db/repositories/jobs";
import {
  ROUTE_EVENT_JOB_MAX_ATTEMPTS,
  ROUTE_EVENT_JOB_TYPE,
  type RouteEventJobPayload,
} from "../routing/service";

export const eventEnvelopeSchema = z.object({
  source: z.string().trim().min(1),
  type: z
    .string()
    .regex(
      /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
      "must be a namespaced event type such as package.detected"
    ),
  payload: z.record(z.string(), z.unknown()),
  sourceEventId: z.string().trim().min(1).optional(),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** Event types that start work beyond a plain publish need an extra capability. */
const EVENT_TYPE_CAPABILITIES: Record<string, ServiceCapability> = {
  "coding.task.requested": "coding:request",
  "deploy.requested": "deploy:request",
  "git.merge.requested": "deploy:request",
};

export function requiredCapabilities(type: string): ServiceCapability[] {
  const extra = EVENT_TYPE_CAPABILITIES[type];
  return extra ? ["events:publish", extra] : ["events:publish"];
}

export interface PublishResult {
  eventId: string;
  duplicate: boolean;
}

/**
 * Store a structured event and queue it for routing. The envelope sourceEventId, or else the
 * Idempotency-Key header, deduplicates by source through the incoming_events unique key.
 */
export function publishEvent(
  db: Database,
  envelope: EventEnvelope,
  idempotencyKey: string | null,
  correlationId: string
): PublishResult {
  const sourceEventId = envelope.sourceEventId ?? idempotencyKey;

  return db.transaction(() => {
    if (sourceEventId) {
      const existing = findEventBySource(db, envelope.source, sourceEventId);
      if (existing) return { eventId: existing.id, duplicate: true };
    }

    const event = createEvent(db, {
      source: envelope.source,
      sourceEventId,
      type: envelope.type,
      payload: envelope.payload,
      metadata: { correlationId, idempotencyKey },
    });
    enqueueJob<RouteEventJobPayload>(db, {
      type: ROUTE_EVENT_JOB_TYPE,
      queue: "delivery",
      payload: { eventId: event.id },
      eventId: event.id,
      maxAttempts: ROUTE_EVENT_JOB_MAX_ATTEMPTS,
    });
    return { eventId: event.id, duplicate: false };
  })();
}
