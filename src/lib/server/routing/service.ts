import type { Database } from "bun:sqlite";
import { createActionResult, type ActionResult } from "../db/repositories/actionResults";
import {
  createDelivery,
  findDeliveryByIdempotencyKey,
  updateDelivery,
  type Delivery,
} from "../db/repositories/deliveries";
import type { IncomingEvent } from "../db/repositories/events";
import type { Action } from "../classifier/schemas";
import type { Classification } from "../db/repositories/classifications";
import { getEvent } from "../db/repositories/events";
import { createIntegrationRegistry, type IntegrationRegistry } from "../integrations/registry";
import type { DeliveryEnvelope, OwnerDeliveryResult } from "../integrations/types";
import { createDeliveryEnvelope } from "./envelope";
import { resolveRoute } from "./resolve";

type RoutedDelivery = Delivery<DeliveryEnvelope, OwnerDeliveryResult>;

export type RoutingOutcome =
  | {
      status: "succeeded";
      delivery: RoutedDelivery;
      actionResult: ActionResult | null;
    }
  | {
      status: "failed";
      delivery: RoutedDelivery;
      actionResult: ActionResult;
    }
  | { status: "unrouted"; actionResult: ActionResult };

export interface RoutingService {
  routeAction(event: IncomingEvent, action: Action): Promise<RoutingOutcome>;
  routeEvent(event: IncomingEvent): Promise<RoutingOutcome>;
}

export interface RoutingServiceOptions {
  db: Database;
  registry?: IntegrationRegistry;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRoutingService({
  db,
  registry = createIntegrationRegistry(),
}: RoutingServiceOptions): RoutingService {
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
    const existing = findDeliveryByIdempotencyKey<DeliveryEnvelope, OwnerDeliveryResult>(
      db,
      envelope.idempotencyKey
    );

    if (existing?.status === "succeeded") {
      return { status: "succeeded", delivery: existing, actionResult: null };
    }

    let delivery: RoutedDelivery;
    if (!existing) {
      delivery = createDelivery<DeliveryEnvelope, OwnerDeliveryResult>(db, {
        eventId: event.id,
        integrationId: resolved.integration.id,
        routeId: resolved.route.id,
        status: "pending",
        idempotencyKey: envelope.idempotencyKey,
        request: envelope,
      });
    } else {
      updateDelivery(db, existing.id, { status: "pending", lastError: null });
      delivery = findDeliveryByIdempotencyKey<DeliveryEnvelope, OwnerDeliveryResult>(
        db,
        envelope.idempotencyKey
      )!;
    }

    let result: OwnerDeliveryResult;
    try {
      const adapter = registry.getAdapter(resolved.integration.kind);
      if (!adapter) {
        throw new Error(`No owner adapter is registered for kind ${resolved.integration.kind}.`);
      }
      if (!adapter.supportedActionTypes.includes(actionType)) {
        throw new Error(
          `Integration "${resolved.integration.name}" does not support action type ${actionType}.`
        );
      }
      result = await adapter.deliver(resolved.integration, envelope);
    } catch (error) {
      const message = errorText(error);
      const failed = db.transaction(() => {
        updateDelivery(db, delivery.id, {
          status: "failed",
          attempts: delivery.attempts + 1,
          lastError: message,
        });
        const updatedDelivery = findDeliveryByIdempotencyKey<DeliveryEnvelope, OwnerDeliveryResult>(
          db,
          envelope.idempotencyKey
        )!;
        const actionResult = createActionResult(db, {
          eventId: event.id,
          actionType,
          status: "failed",
          result: {
            integrationId: resolved.integration.id,
            integrationName: resolved.integration.name,
            routeId: resolved.route.id,
          },
          error: message,
        });
        return { delivery: updatedDelivery, actionResult };
      })();
      return { status: "failed", ...failed };
    }

    const succeeded = db.transaction(() => {
      updateDelivery(db, delivery.id, {
        status: "succeeded",
        attempts: delivery.attempts + 1,
        response: result,
        lastError: null,
      });
      const updatedDelivery = findDeliveryByIdempotencyKey<DeliveryEnvelope, OwnerDeliveryResult>(
        db,
        envelope.idempotencyKey
      )!;
      const actionResult = createActionResult(db, {
        eventId: event.id,
        actionType,
        status: "succeeded",
        result: {
          integrationId: resolved.integration.id,
          integrationName: resolved.integration.name,
          routeId: resolved.route.id,
          downstreamId: result.downstreamId,
          id: result.downstreamId,
        },
      });
      return { delivery: updatedDelivery, actionResult };
    })();

    return { status: "succeeded", ...succeeded };
  }

  return {
    routeAction: (event, action) => deliver(event, action.type, action),
    routeEvent: (event) => deliver(event, event.type, event.payload),
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
