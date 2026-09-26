import type { Database } from "bun:sqlite";
import { AdminActionError } from "./admin-error";
import { nowIso } from "./db/json";
import { getDelivery, updateDelivery, type Delivery } from "./db/repositories/deliveries";
import { requeueJob, type Job } from "./db/repositories/jobs";
import { enqueueDeliveryRetry } from "./routing/service";

export interface FailedClassification {
  jobId: string;
  eventId: string;
  source: string;
  eventType: string;
  attempts: number;
  lastError: string | null;
  failedAt: string;
}

export interface FailedDelivery {
  deliveryId: string;
  eventId: string;
  source: string;
  actionType: string | null;
  destination: string;
  attempts: number;
  lastError: string | null;
  failedAt: string;
}

export interface FailureList {
  classifications: FailedClassification[];
  deliveries: FailedDelivery[];
}

/**
 * List classification jobs that used all their attempts, and deliveries that are dead.
 * A "failed" delivery is not listed because it already has a scheduled retry.
 */
export function listFailures(db: Database): FailureList {
  const classifications = db
    .query<FailedClassification, []>(
      `SELECT j.id AS jobId, e.id AS eventId, e.source, e.type AS eventType, j.attempts,
              j.last_error AS lastError, j.updated_at AS failedAt
       FROM jobs j
       JOIN incoming_events e ON e.id = j.event_id
       WHERE j.queue = 'classification' AND j.status IN ('failed', 'dead')
       ORDER BY j.updated_at DESC, j.id DESC`
    )
    .all();

  const deliveries = db
    .query<FailedDelivery, []>(
      `SELECT d.id AS deliveryId, e.id AS eventId, e.source,
              json_extract(d.request, '$.actionType') AS actionType, i.name AS destination,
              d.attempts, d.last_error AS lastError, d.updated_at AS failedAt
       FROM deliveries d
       JOIN incoming_events e ON e.id = d.event_id
       JOIN integrations i ON i.id = d.integration_id
       WHERE d.status = 'dead'
       ORDER BY d.updated_at DESC, d.id DESC`
    )
    .all();

  return { classifications, deliveries };
}

/**
 * Put the latest classification job of an event back in the classification queue. The earlier
 * processing attempts stay in the history, and the worker records a new attempt for the retry.
 */
export function retryClassification(db: Database, eventId: string, at = nowIso()): Job {
  const job = db
    .query<{ id: string; status: string }, [string]>(
      `SELECT id, status FROM jobs WHERE queue = 'classification' AND event_id = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(eventId);
  if (!job) throw new AdminActionError(404, `Event ${eventId} has no classification job.`);

  const requeued = requeueJob(db, job.id, at);
  if (!requeued) {
    throw new AdminActionError(409, `The classification of event ${eventId} is ${job.status}.`);
  }
  return requeued;
}

/**
 * Schedule a dead delivery for the delivery worker with a new retry budget. The delivery keeps
 * its idempotency key, and its failed action result stays in the history.
 */
export function retryDelivery(db: Database, deliveryId: string, at = nowIso()): Delivery {
  const delivery = getDelivery(db, deliveryId);
  if (!delivery) throw new AdminActionError(404, `Delivery ${deliveryId} does not exist.`);
  if (delivery.status !== "dead") {
    throw new AdminActionError(409, `Delivery ${deliveryId} is ${delivery.status}.`);
  }

  return db.transaction(() => {
    const updated = updateDelivery(db, delivery.id, {
      status: "failed",
      attempts: 0,
      nextAttemptAt: at,
    })!;
    enqueueDeliveryRetry(db, delivery, at);
    return updated;
  })();
}
