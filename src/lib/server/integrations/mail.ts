import type { Integration } from "../db/repositories/integrations";
import { fetchTransport, postJson, requireObjectId } from "./http";
import type { DeliveryEnvelope, HttpTransport, OwnerAdapter } from "./types";

const MAIL_ENDPOINTS = {
  "task.create": "tasks",
  "reminder.create": "reminders",
  "note.create": "notes",
  "note.append": "notes/append",
} as const;
const MAIL_RESPONSE_ID_FIELD = "id";

/**
 * Mail's request field names and endpoints are provisional until its receiver contract is
 * agreed. Keep the mapping here so that contract changes stay within this adapter.
 *
 * `reminder.create` posts `{ text, remindAt, timeZone, originalTimePhrase, sourceEventId }`
 * to `reminders` with the delivery's stable `Idempotency-Key` header, and Relay records the
 * `id` field of the response as the Mail reminder ID. Mail owns scheduling and surfacing
 * the reminder; Relay only creates it and never schedules the notification itself.
 */
function mailRequest(envelope: DeliveryEnvelope): { path: string; body: unknown } {
  const payload = envelope.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(
      `Mail cannot deliver ${envelope.actionType}: action payload must be an object.`
    );
  }
  const action = payload as Record<string, unknown>;

  switch (envelope.actionType) {
    case "task.create":
      return {
        path: MAIL_ENDPOINTS["task.create"],
        body: {
          title: action.title,
          notes: action.notes,
          dueAt: action.dueAt,
          sourceEventId: envelope.eventId,
        },
      };
    case "reminder.create":
      return {
        path: MAIL_ENDPOINTS["reminder.create"],
        body: {
          text: action.text,
          remindAt: action.remindAt,
          timeZone: action.timeZone,
          originalTimePhrase: action.originalTimePhrase,
          sourceEventId: envelope.eventId,
        },
      };
    case "note.create":
      return {
        path: MAIL_ENDPOINTS["note.create"],
        body: {
          title: action.title,
          body: action.body,
          topic: action.topic,
          sourceEventId: envelope.eventId,
        },
      };
    case "note.append":
      return {
        path: MAIL_ENDPOINTS["note.append"],
        body: {
          body: action.body,
          targetId: action.targetId,
          contextEventId: action.contextEventId,
          sourceEventId: envelope.eventId,
        },
      };
    default:
      throw new Error(`Mail does not support action type ${envelope.actionType}.`);
  }
}

export function createMailAdapter(transport: HttpTransport = fetchTransport): OwnerAdapter {
  return {
    kind: "mail",
    supportedActionTypes: Object.keys(MAIL_ENDPOINTS),
    async deliver(integration: Integration, envelope: DeliveryEnvelope) {
      const { path, body } = mailRequest(envelope);
      const response = await postJson({ integration, envelope, path, body, transport });
      const downstreamId = requireObjectId(
        response,
        MAIL_RESPONSE_ID_FIELD,
        `Mail response for ${envelope.actionType} did not include an object id.`
      );
      return { downstreamId, response };
    },
  };
}
