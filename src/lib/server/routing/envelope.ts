import type { IncomingEvent } from "../db/repositories/events";
import type { DeliveryEnvelope } from "../integrations/types";

/**
 * JSON tuple encoding keeps the event, action, and owner identity unambiguous. An operator
 * correction adds its processing attempt ID, so its dispatch is a new downstream request that
 * stays tied to the source event.
 */
export function createIdempotencyKey(
  eventId: string,
  actionType: string,
  integrationId: string,
  attemptId?: string
): string {
  const tuple = [eventId, actionType, integrationId];
  if (attemptId) tuple.push(attemptId);
  const identity = encodeURIComponent(JSON.stringify(tuple));
  return `relay:${identity}`;
}

export function createDeliveryEnvelope<TPayload>(
  event: IncomingEvent,
  actionType: string,
  integrationId: string,
  payload: TPayload,
  attemptId?: string
): DeliveryEnvelope<TPayload> {
  const storedCorrelationId = event.metadata?.correlationId;
  return {
    eventId: event.id,
    correlationId:
      typeof storedCorrelationId === "string" && storedCorrelationId.length > 0
        ? storedCorrelationId
        : event.id,
    actionType,
    payload,
    idempotencyKey: createIdempotencyKey(event.id, actionType, integrationId, attemptId),
  };
}
