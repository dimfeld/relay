import type { Database } from "bun:sqlite";
import { DEFAULT_DELIVERY_MAX_ATTEMPTS } from "../config";
import {
  createActionResult,
  listActionResultsForEvent,
  updateActionResult,
  type ActionResult,
} from "../db/repositories/actionResults";
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
import { TIM_PLAN_REQUEST_EVENT_TYPES } from "../classifier/schemas";
import type { Classification } from "../db/repositories/classifications";
import { getEvent } from "../db/repositories/events";
import { DeliveryError } from "../integrations/http";
import { createIntegrationRegistry, type IntegrationRegistry } from "../integrations/registry";
import {
  createTimCli,
  type TimCli,
  type TimPlanAction,
  type TimQueueMode,
} from "../integrations/tim";
import type { DeliveryEnvelope, OwnerDeliveryResult } from "../integrations/types";
import { log as defaultLog } from "../logging";
import { correlationIdForEvent } from "../logging";
import type { OperationalMetrics } from "../logging/metrics";
import { operationalMetrics } from "../logging/metrics";
import { exponentialBackoff, type Backoff } from "../queue/backoff";
import type { QueueHandler } from "../queue/worker";
import { createDeliveryEnvelope } from "./envelope";
import { recordResponse, type DeliveryResponse } from "./response";
import { resolveRoute } from "./resolve";
import { resolveProject as resolveCatalogProject } from "../projects/catalog";

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

export interface TimPlanOutcome {
  status: "tim_plan";
  outcome: "succeeded" | "failed" | "needs_reconciliation";
  actionResult: ActionResult;
}

export type RoutingOutcome =
  | DeliveryOutcome
  | { status: "unrouted"; actionResult: ActionResult }
  | TimPlanOutcome;

export interface RouteActionOptions {
  /** Set for an operator correction, so its delivery gets a new idempotency key. */
  attemptId?: string;
}

export interface RoutingService {
  routeAction(
    event: IncomingEvent,
    action: Action,
    options?: RouteActionOptions
  ): Promise<RoutingOutcome>;
  routeEvent(event: IncomingEvent): Promise<RoutingOutcome>;
  /** Send a failed delivery again when its retry is due. Returns null when nothing is due. */
  runScheduledDelivery(deliveryId: string): Promise<DeliveryOutcome | null>;
  /** Manually retry a delivery that did not succeed, with a new retry budget. */
  retryDelivery(deliveryId: string): Promise<DeliveryOutcome>;
}

export interface RoutingServiceOptions {
  db: Database;
  registry?: IntegrationRegistry;
  timCli?: TimCli;
  maxAttempts?: number;
  backoff?: Backoff;
  now?: () => Date;
  log?: typeof defaultLog;
  metrics?: OperationalMetrics;
}

export interface DeliveryRetryJobPayload {
  deliveryId: string;
}

/** A structured event from the internal API skips classification and routes by its own type. */
export const ROUTE_EVENT_JOB_TYPE = "event.route";

/** The delivery row owns retries after routing, the same as a delivery retry job. */
export const ROUTE_EVENT_JOB_MAX_ATTEMPTS = DELIVERY_RETRY_JOB_MAX_ATTEMPTS;

export interface RouteEventJobPayload {
  eventId: string;
}

/** Queue one attempt of a delivery that has status "failed" and is due at availableAt. */
export function enqueueDeliveryRetry(
  db: Database,
  delivery: Pick<Delivery, "id" | "eventId">,
  availableAt: string
): Job<DeliveryRetryJobPayload> {
  return enqueueJob<DeliveryRetryJobPayload>(db, {
    type: "delivery.retry",
    queue: "delivery",
    payload: { deliveryId: delivery.id },
    eventId: delivery.eventId,
    maxAttempts: DELIVERY_RETRY_JOB_MAX_ATTEMPTS,
    availableAt,
  });
}

function isTimPlanAction(action: Action): action is TimPlanAction {
  return action.type === "tim.plan.create" || action.type === "tim.plan.create_and_execute";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasCleanCommandFailure(result: unknown): boolean {
  return (
    isRecord(result) && isRecord(result.commandOutcome) && result.commandOutcome.state === "failed"
  );
}

function timActionKey(eventId: string, attemptId?: string) {
  return JSON.stringify([eventId, attemptId ?? "initial"]);
}

function timQueueMode(actionType: TimPlanAction["type"]): TimQueueMode {
  return actionType === "tim.plan.create_and_execute" ? "queued" : "default";
}

type RequestedTimAction =
  | { action: TimPlanAction }
  | { actionType: TimPlanAction["type"]; reason: string };

function requestedTimAction(db: Database, event: IncomingEvent): RequestedTimAction | null {
  const actionType =
    TIM_PLAN_REQUEST_EVENT_TYPES[event.type as keyof typeof TIM_PLAN_REQUEST_EVENT_TYPES];
  if (!actionType) return null;

  const payload = event.payload;
  if (!isRecord(payload))
    return { actionType, reason: "Tim plan event payload must be an object." };
  const extraFields = Object.keys(payload).filter(
    (field) => !["project", "description"].includes(field)
  );
  if (extraFields.length) {
    return {
      actionType,
      reason: "Tim plan event payload can contain only project and description.",
    };
  }
  if (typeof payload.project !== "string" || !payload.project.trim()) {
    return { actionType, reason: "A registered project name or alias is required." };
  }
  if (typeof payload.description !== "string" || !payload.description.trim()) {
    return { actionType, reason: "A non-empty plan description is required." };
  }
  const project = resolveCatalogProject(db, payload.project);
  if (!project)
    return { actionType, reason: "The project is not registered in the project catalog." };
  return {
    action: {
      type: actionType,
      projectId: project.id,
      projectName: project.name,
      description: payload.description,
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRoutingService({
  db,
  registry = createIntegrationRegistry(),
  timCli = createTimCli(),
  maxAttempts = DEFAULT_DELIVERY_MAX_ATTEMPTS,
  backoff = exponentialBackoff,
  now = () => new Date(),
  log = defaultLog,
  metrics = operationalMetrics,
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
    result: OwnerDeliveryResult,
    durationMs: number
  ): DeliveryOutcome {
    const outcome = db.transaction(() => {
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
    log("info", "delivery attempt completed", {
      stage: "delivery",
      correlationId: delivery.request.correlationId,
      eventId: delivery.eventId,
      deliveryId: delivery.id,
      integrationId: delivery.integrationId,
      attempts,
      durationMs,
      status: "succeeded",
    });
    return outcome;
  }

  function recordFailure(
    delivery: RoutedDelivery,
    attempts: number,
    error: unknown,
    durationMs: number
  ): DeliveryOutcome {
    const message = errorText(error);
    const deliveryError = error instanceof DeliveryError ? error : null;
    const retry = deliveryError?.transient === true && attempts < maxAttempts;
    const nextAttemptAt = retry
      ? new Date(now().getTime() + backoff(attempts)).toISOString()
      : null;
    const status: DeliveryStatus = retry ? "failed" : "dead";
    const outcome = db.transaction(() => {
      updateDelivery(db, delivery.id, {
        status,
        attempts,
        nextAttemptAt,
        response: deliveryError?.response ? recordResponse(deliveryError.response) : null,
        lastError: message,
      });
      if (retry) {
        enqueueDeliveryRetry(db, delivery, nextAttemptAt!);
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
    const retryCount = retry ? metrics.recordDeliveryRetry() : undefined;
    log(retry ? "warn" : "error", "delivery attempt failed", {
      stage: "delivery",
      correlationId: delivery.request.correlationId,
      eventId: delivery.eventId,
      deliveryId: delivery.id,
      integrationId: delivery.integrationId,
      attempts,
      durationMs,
      status,
      retryScheduled: retry,
      retryCount,
      httpStatus: deliveryError?.response?.status ?? null,
      nextAttemptAt,
      error: message,
    });
    return outcome;
  }

  /** Send a delivery that is already persisted as pending, and record the outcome. */
  async function attempt(delivery: RoutedDelivery): Promise<DeliveryOutcome> {
    const envelope = delivery.request;
    const attempts = delivery.attempts + 1;
    const startedAt = performance.now();
    log("info", "delivery attempt started", {
      stage: "delivery",
      correlationId: envelope.correlationId,
      eventId: delivery.eventId,
      deliveryId: delivery.id,
      integrationId: delivery.integrationId,
      attempts,
    });
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
      return recordFailure(delivery, attempts, error, performance.now() - startedAt);
    }
    return recordSuccess(delivery, attempts, result, performance.now() - startedAt);
  }

  function invalidTimRequest(
    event: IncomingEvent,
    actionType: TimPlanAction["type"],
    reason: string
  ): TimPlanOutcome {
    const idempotencyKey = timActionKey(event.id);
    const existing = listActionResultsForEvent(db, event.id)
      .reverse()
      .find((entry) => isRecord(entry.result) && entry.result.idempotencyKey === idempotencyKey);
    if (existing) {
      return {
        status: "tim_plan",
        outcome: existing.status as TimPlanOutcome["outcome"],
        actionResult: existing,
      };
    }

    const actionResult = createActionResult(db, {
      eventId: event.id,
      actionType,
      status: "failed",
      result: {
        idempotencyKey,
        actionType,
        projectId: null,
        timPlanId: null,
        queueMode: timQueueMode(actionType),
        commandOutcome: { state: "not_started" },
      },
      error: reason,
    });
    return { status: "tim_plan", outcome: "failed", actionResult };
  }

  async function runTimPlan(
    event: IncomingEvent,
    action: TimPlanAction,
    attemptId?: string
  ): Promise<TimPlanOutcome> {
    const project = resolveCatalogProject(db, action.projectId);
    if (!project) {
      return invalidTimRequest(
        event,
        action.type,
        "The project is not enabled in the project catalog."
      );
    }

    const idempotencyKey = timActionKey(event.id, attemptId);
    const previous = db.transaction(() => {
      const matching = listActionResultsForEvent(db, event.id)
        .filter((entry) => isRecord(entry.result) && entry.result.idempotencyKey === idempotencyKey)
        .at(-1);
      if (matching) {
        if (matching.status === "succeeded" || matching.status === "needs_reconciliation") {
          return { kind: "recorded" as const, actionResult: matching };
        }
        if (matching.status === "running") {
          const result = {
            ...(isRecord(matching.result) ? matching.result : {}),
            commandOutcome: {
              state: "uncertain",
              reason: "A prior Tim command has no recorded outcome.",
            },
          };
          const updated = updateActionResult(db, matching.id, {
            status: "needs_reconciliation",
            result,
            error: "A prior Tim command has no recorded outcome. Reconcile it before retrying.",
          })!;
          return { kind: "recorded" as const, actionResult: updated };
        }
        if (matching.status === "failed" && !hasCleanCommandFailure(matching.result)) {
          return { kind: "recorded" as const, actionResult: matching };
        }
      }

      const actionResult = createActionResult(db, {
        eventId: event.id,
        actionType: action.type,
        status: "running",
        result: {
          idempotencyKey,
          actionType: action.type,
          action: {
            projectId: action.projectId,
            projectName: action.projectName,
            description: action.description,
          },
          projectId: action.projectId,
          projectName: action.projectName,
          timPlanId: null,
          queueMode: timQueueMode(action.type),
          commandOutcome: { state: "started" },
          ...(attemptId ? { attemptId } : {}),
        },
      });
      return { kind: "started" as const, actionResult };
    })();

    if (previous.kind === "recorded") {
      return {
        status: "tim_plan",
        outcome: previous.actionResult.status as TimPlanOutcome["outcome"],
        actionResult: previous.actionResult,
      };
    }

    const started = previous.actionResult;

    let commandResult;
    try {
      commandResult = await timCli.createPlan(action, project.directory);
    } catch (error) {
      const message = errorText(error);
      const actionResult = updateActionResult(db, started.id, {
        status: "needs_reconciliation",
        result: {
          ...(isRecord(started.result) ? started.result : {}),
          commandOutcome: { state: "uncertain", error: message },
        },
        error: "The Tim command ended without a recorded outcome. Reconcile it before retrying.",
      })!;
      return { status: "tim_plan", outcome: "needs_reconciliation", actionResult };
    }

    const finalResult = {
      ...(isRecord(started.result) ? started.result : {}),
      timPlanId: commandResult.planId,
      queueMode: commandResult.queueMode,
      commandOutcome: commandResult.commandOutcome,
    };
    if (commandResult.status === "needs_reconciliation") {
      const actionResult = updateActionResult(db, started.id, {
        status: "needs_reconciliation",
        result: finalResult,
        error:
          "Tim returned successfully but Relay could not read the new plan ID. Reconcile it before retrying.",
      })!;
      return { status: "tim_plan", outcome: "needs_reconciliation", actionResult };
    }
    if (commandResult.status === "failed") {
      const error = `Tim exited with code ${commandResult.commandOutcome.exitCode}.`;
      updateActionResult(db, started.id, {
        status: "failed",
        result: finalResult,
        error,
      });
      // A nonzero exit is a clean failure. The durable job retry may run `tim add` again.
      throw new Error(error);
    }

    const actionResult = updateActionResult(db, started.id, {
      status: "succeeded",
      result: finalResult,
      error: null,
    })!;
    return { status: "tim_plan", outcome: "succeeded", actionResult };
  }

  async function deliver(
    event: IncomingEvent,
    actionType: string,
    payload: unknown,
    attemptId?: string
  ): Promise<RoutingOutcome> {
    const correlationId = correlationIdForEvent(event);
    log("info", "routing started", {
      stage: "routing",
      correlationId,
      eventId: event.id,
      eventType: event.type,
      actionType,
    });
    const resolved = resolveRoute(db, { eventType: event.type, actionType });
    if (!resolved) {
      const message = `No enabled route matched event ${event.type} and action ${actionType}.`;
      log("warn", "event has no matching route", {
        stage: "routing",
        correlationId,
        eventId: event.id,
        eventType: event.type,
        actionType,
      });
      const actionResult = createActionResult(db, {
        eventId: event.id,
        actionType,
        status: "unrouted",
        result: { reason: "no_enabled_route" },
        error: message,
      });
      return { status: "unrouted", actionResult };
    }

    const envelope = createDeliveryEnvelope(
      event,
      actionType,
      resolved.integration.id,
      payload,
      attemptId
    );
    const existing = findDeliveryByIdempotencyKey<DeliveryEnvelope, DeliveryResponse>(
      db,
      envelope.idempotencyKey
    );
    // An existing delivery already has its own retry path, so routing it again does not resend.
    if (existing) {
      log("info", "delivery already recorded", {
        stage: "routing",
        correlationId,
        eventId: event.id,
        deliveryId: existing.id,
        status: existing.status,
      });
      return { status: existing.status, delivery: existing, actionResult: null };
    }

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
    routeAction: (event, action, options) =>
      isTimPlanAction(action)
        ? runTimPlan(event, action, options?.attemptId)
        : deliver(event, action.type, action, options?.attemptId),
    routeEvent: async (event) => {
      const request = requestedTimAction(db, event);
      if (!request) return deliver(event, event.type, event.payload);
      if ("reason" in request) return invalidTimRequest(event, request.actionType, request.reason);
      return runTimPlan(event, request.action);
    },
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

/** Create the "delivery" queue handler for structured-event routing and delivery retries. */
export function createDeliveryQueueHandler(
  db: Database,
  routing: RoutingService
): QueueHandler<DeliveryRetryJobPayload | RouteEventJobPayload> {
  const retry = createDeliveryRetryHandler(routing);
  return async (job) => {
    if (job.type !== ROUTE_EVENT_JOB_TYPE) return retry(job as Job<DeliveryRetryJobPayload>);

    const { eventId } = job.payload as RouteEventJobPayload;
    const event = getEvent(db, eventId);
    if (!event) throw new Error(`Event ${eventId} does not exist.`);
    await routing.routeEvent(event);
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
