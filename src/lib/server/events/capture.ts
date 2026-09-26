import type { Database } from "bun:sqlite";
import { CLASSIFICATION_JOB_MAX_ATTEMPTS } from "../config";
import { createEvent, type CreateEventInput, type IncomingEvent } from "../db/repositories/events";
import { enqueueJob } from "../db/repositories/jobs";

/**
 * Store a text capture and queue its classification job.
 *
 * Call this inside a database transaction so the event and job commit together.
 */
export function createCaptureInTransaction(db: Database, input: CreateEventInput): IncomingEvent {
  const event = createEvent(db, input);
  enqueueJob(db, {
    type: "classify",
    queue: "classification",
    payload: { eventId: event.id },
    eventId: event.id,
    maxAttempts: CLASSIFICATION_JOB_MAX_ATTEMPTS,
  });
  return event;
}
