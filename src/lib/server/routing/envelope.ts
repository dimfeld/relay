import type { IncomingEvent } from "../db/repositories/events";
import type { DeliveryEnvelope } from "../integrations/types";

/** JSON tuple encoding keeps the event, action, and owner identity unambiguous. */
export function createIdempotencyKey(
  eventId: string,
  actionType: string,
  integrationId: string
): string {
  const identity = encodeURIComponent(JSON.stringify([eventId, actionType, integrationId]));
  return `relay:${identity}`;
}

export function createDeliveryEnvelope<TPayload>(
  event: IncomingEvent,
  actionType: string,
  integrationId: string,
  payload: TPayload
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
    idempotencyKey: createIdempotencyKey(event.id, actionType, integrationId),
  };
}
