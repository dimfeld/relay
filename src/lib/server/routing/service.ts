import type { Database } from "bun:sqlite";
import { DEFAULT_DELIVERY_MAX_ATTEMPTS } from "../config";
import { createActionResult, type ActionResult } from "../db/repositories/actionResults";
import {
  createDelivery,
  findDeliveryByIdempotencyKey,
  getDelivery,
  updateDelivery,
  type Delivery,
  type DeliveryStatus,
} from "../db/repositories/deliveries";
import type { IncomingEvent } from "../db/repositories/events";
import { getIntegration } from "../db/repositories/integrations";
import { enqueueJob, type Job } from "../db/repositories/jobs";
import type { Action } from "../classifier/schemas";
import type { Classification } from "../db/repositories/classifications";
import { getEvent } from "../db/repositories/events";
import { DeliveryError } from "../integrations/http";
import { createIntegrationRegistry, type IntegrationRegistry } from "../integrations/registry";
import type { DeliveryEnvelope, OwnerDeliveryResult } from "../integrations/types";
import { log as defaultLog } from "../logging";
import { exponentialBackoff, type Backoff } from "../queue/backoff";
import type { QueueHandler } from "../queue/worker";
import { createDeliveryEnvelope } from "./envelope";
import { recordResponse, type DeliveryResponse } from "./response";
import { resolveRoute } from "./resolve";

type RoutedDelivery = Delivery<DeliveryEnvelope, DeliveryResponse>;

/**
 * The delivery row owns the retry state, so a retry job only triggers one attempt. A delivery
 * that fails again schedules a new job.
 */
const DELIVERY_RETRY_JOB_MAX_ATTEMPTS = 1;

/** A "failed" delivery has a scheduled retry; a "dead" delivery needs a manual retry. */
export interface DeliveryOutcome {
  status: DeliveryStatus;
  delivery: RoutedDelivery;
  /** Written only when a delivery reaches a final result (succeeded or dead). */
  actionResult: ActionResult | null;
}

export type RoutingOutcome = DeliveryOutcome | { status: "unrouted"; actionResult: ActionResult };

export interface RoutingService {
  routeAction(event: IncomingEvent, action: Action): Promise<RoutingOutcome>;
  routeEvent(event: IncomingEvent): Promise<RoutingOutcome>;
  /** Send a failed delivery again when its retry is due. Returns null when nothing is due. */
  runScheduledDelivery(deliveryId: string): Promise<DeliveryOutcome | null>;
  /** Manually retry a delivery that did not succeed, with a new retry budget. */
  retryDelivery(deliveryId: string): Promise<DeliveryOutcome>;
}

export interface RoutingServiceOptions {
  db: Database;
  registry?: IntegrationRegistry;
  maxAttempts?: number;
  backoff?: Backoff;
  now?: () => Date;
  log?: typeof defaultLog;
}

export interface DeliveryRetryJobPayload {
  deliveryId: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRoutingService({
  db,
  registry = createIntegrationRegistry(),
  maxAttempts = DEFAULT_DELIVERY_MAX_ATTEMPTS,
  backoff = exponentialBackoff,
  now = () => new Date(),
  log = defaultLog,
}: RoutingServiceOptions): RoutingService {
  function loadDelivery(id: string): RoutedDelivery | null {
    return getDelivery<DeliveryEnvelope, DeliveryResponse>(db, id);
  }

  function actionResultDetails(delivery: RoutedDelivery) {
    return {
      deliveryId: delivery.id,
      integrationId: delivery.integrationId,
      integrationName: getIntegration(db, delivery.integrationId)?.name ?? null,
      routeId: delivery.routeId,
    };
  }

  function recordSuccess(
    delivery: RoutedDelivery,
    attempts: number,
    result: OwnerDeliveryResult
  ): DeliveryOutcome {
    return db.transaction(() => {
      updateDelivery(db, delivery.id, {
        status: "succeeded",
        attempts,
        nextAttemptAt: null,
        response: recordResponse(result.response, result.downstreamId),
        lastError: null,
      });
      const actionResult = createActionResult(db, {
        eventId: delivery.eventId,
        actionType: delivery.request.actionType,
        status: "succeeded",
        result: {
          ...actionResultDetails(delivery),
          downstreamId: result.downstreamId,
          id: result.downstreamId,
        },
      });
      return { status: "succeeded" as const, delivery: loadDelivery(delivery.id)!, actionResult };
    })();
  }

  function recordFailure(
    delivery: RoutedDelivery,
    attempts: number,
    error: unknown
  ): DeliveryOutcome {
    const message = errorText(error);
    const deliveryError = error instanceof DeliveryError ? error : null;
    const retry = deliveryError?.transient === true && attempts < maxAttempts;
    const nextAttemptAt = retry
      ? new Date(now().getTime() + backoff(attempts)).toISOString()
      : null;
    const status: DeliveryStatus = retry ? "failed" : "dead";

    log(retry ? "warn" : "error", "delivery attempt failed", {
      correlationId: delivery.request.correlationId,
      eventId: delivery.eventId,
      deliveryId: delivery.id,
      integrationId: delivery.integrationId,
      attempts,
      status,
      httpStatus: deliveryError?.response?.status ?? null,
      nextAttemptAt,
      error: message,
    });

    return db.transaction(() => {
      updateDelivery(db, delivery.id, {
        status,
        attempts,
        nextAttemptAt,
        response: deliveryError?.response ? recordResponse(deliveryError.response) : null,
        lastError: message,
      });
      if (retry) {
        enqueueJob<DeliveryRetryJobPayload>(db, {
          type: "delivery.retry",
          queue: "delivery",
          payload: { deliveryId: delivery.id },
          eventId: delivery.eventId,
          maxAttempts: DELIVERY_RETRY_JOB_MAX_ATTEMPTS,
          availableAt: nextAttemptAt!,
        });
        return { status, delivery: loadDelivery(delivery.id)!, actionResult: null };
      }
      const actionResult = createActionResult(db, {
        eventId: delivery.eventId,
        actionType: delivery.request.actionType,
        status: "failed",
        result: actionResultDetails(delivery),
        error: message,
      });
      return { status, delivery: loadDelivery(delivery.id)!, actionResult };
    })();
  }

  /** Send a delivery that is already persisted as pending, and record the outcome. */
  async function attempt(delivery: RoutedDelivery): Promise<DeliveryOutcome> {
    const envelope = delivery.request;
    const attempts = delivery.attempts + 1;
    let result: OwnerDeliveryResult;
    try {
      const integration = getIntegration(db, delivery.integrationId);
      if (!integration) throw new Error(`Integration ${delivery.integrationId} does not exist.`);
      const adapter = registry.getAdapter(integration.kind);
      if (!adapter) {
        throw new Error(`No owner adapter is registered for kind ${integration.kind}.`);
      }
      if (!adapter.supportedActionTypes.includes(envelope.actionType)) {
        throw new Error(
          `Integration "${integration.name}" does not support action type ${envelope.actionType}.`
        );
      }
      result = await adapter.deliver(integration, envelope);
    } catch (error) {
      return recordFailure(delivery, attempts, error);
    }
    return recordSuccess(delivery, attempts, result);
  }

  async function deliver(
    event: IncomingEvent,
    actionType: string,
    payload: unknown
  ): Promise<RoutingOutcome> {
    const resolved = resolveRoute(db, { eventType: event.type, actionType });
    if (!resolved) {
      const message = `No enabled route matched event ${event.type} and action ${actionType}.`;
      const actionResult = createActionResult(db, {
        eventId: event.id,
        actionType,
        status: "unrouted",
        result: { reason: "no_enabled_route" },
        error: message,
      });
      return { status: "unrouted", actionResult };
    }

    const envelope = createDeliveryEnvelope(event, actionType, resolved.integration.id, payload);
    const existing = findDeliveryByIdempotencyKey<DeliveryEnvelope, DeliveryResponse>(
      db,
      envelope.idempotencyKey
    );
    // An existing delivery already has its own retry path, so routing it again does not resend.
    if (existing) return { status: existing.status, delivery: existing, actionResult: null };

    const delivery = createDelivery<DeliveryEnvelope, DeliveryResponse>(db, {
      eventId: event.id,
      integrationId: resolved.integration.id,
      routeId: resolved.route.id,
      status: "pending",
      nextAttemptAt: null,
      idempotencyKey: envelope.idempotencyKey,
      request: envelope,
    });
    return attempt(delivery);
  }

  async function runScheduledDelivery(deliveryId: string): Promise<DeliveryOutcome | null> {
    const delivery = loadDelivery(deliveryId);
    if (
      delivery?.status !== "failed" ||
      !delivery.nextAttemptAt ||
      delivery.nextAttemptAt > now().toISOString()
    ) {
      return null;
    }
    updateDelivery(db, delivery.id, { status: "pending", nextAttemptAt: null });
    return attempt({ ...delivery, status: "pending", nextAttemptAt: null });
  }

  async function retryDelivery(deliveryId: string): Promise<DeliveryOutcome> {
    const delivery = loadDelivery(deliveryId);
    if (!delivery) throw new Error(`Delivery ${deliveryId} does not exist.`);
    if (delivery.status === "succeeded")
      return { status: "succeeded", delivery, actionResult: null };

    const reset = { status: "pending" as const, attempts: 0, nextAttemptAt: null, lastError: null };
    updateDelivery(db, delivery.id, reset);
    return attempt({ ...delivery, ...reset });
  }

  return {
    routeAction: (event, action) => deliver(event, action.type, action),
    routeEvent: (event) => deliver(event, event.type, event.payload),
    runScheduledDelivery,
    retryDelivery,
  };
}

/** Create the "delivery" queue handler that runs scheduled delivery retries. */
export function createDeliveryRetryHandler(
  routing: RoutingService
): QueueHandler<DeliveryRetryJobPayload> {
  return async (job: Job<DeliveryRetryJobPayload>) => {
    await routing.runScheduledDelivery(job.payload.deliveryId);
  };
}

/** Create the classification worker hook, which receives only validated actions. */
export function createOnClassifiedCallback(
  db: Database,
  routing: RoutingService = createRoutingService({ db })
): (action: Action, classification: Classification) => Promise<void> {
  return async (action, classification) => {
    const event = getEvent(db, classification.eventId);
    if (!event) throw new Error(`Event ${classification.eventId} does not exist.`);
    await routing.routeAction(event, action);
  };
}
