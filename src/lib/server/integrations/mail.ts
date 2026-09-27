import { z } from "zod";
import type { Category } from "../classifier/types";
import type { Integration } from "../db/repositories/integrations";
import { fetchTransport, getJson, postJson, requireObjectId } from "./http";
import type { DeliveryEnvelope, HttpTransport, OwnerAdapter } from "./types";

/** Mail has one todo type. A reminder is a todo with a due time, so both actions post to `todos`. */
const MAIL_ENDPOINTS = {
  "task.create": "todos",
  "reminder.create": "todos",
  "note.create": "notes",
  "note.append": "notes/append",
} as const;
const MAIL_CATEGORIES_ENDPOINT = "categories";
const MAIL_RESPONSE_ID_FIELD = "id";

const categoriesResponseSchema = z.object({
  categories: z.array(z.object({ id: z.string().trim().min(1), name: z.string().trim().min(1) })),
});

/**
 * Map Relay actions to Mail requests. docs/external-app-changes.md has the full Mail contract.
 * Keep the mapping here so that contract changes stay within this adapter.
 *
 * Mail owns scheduling and surfacing a todo's due time; Relay only creates the todo and never
 * schedules the notification itself.
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
          notes: action.notes ?? null,
          dueAt: action.dueAt ?? null,
          timeZone: null,
          originalTimePhrase: null,
          categoryId: action.categoryId ?? null,
          sourceEventId: envelope.eventId,
        },
      };
    case "reminder.create":
      return {
        path: MAIL_ENDPOINTS["reminder.create"],
        body: {
          title: action.text,
          notes: null,
          dueAt: action.remindAt,
          timeZone: action.timeZone ?? null,
          originalTimePhrase: action.originalTimePhrase ?? null,
          categoryId: action.categoryId ?? null,
          sourceEventId: envelope.eventId,
        },
      };
    case "note.create":
      return {
        path: MAIL_ENDPOINTS["note.create"],
        body: {
          title: action.title ?? null,
          body: action.body,
          topic: action.topic ?? null,
          categoryId: action.categoryId ?? null,
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

/** Read the categories that Mail lets Relay assign to todos and notes. */
export async function fetchMailCategories(
  integration: Integration,
  correlationId: string,
  transport: HttpTransport = fetchTransport
): Promise<Category[]> {
  const response = await getJson({
    integration,
    path: MAIL_CATEGORIES_ENDPOINT,
    correlationId,
    transport,
  });
  const parsed = categoriesResponseSchema.safeParse(response.body);
  if (!parsed.success) {
    throw new Error(`Mail categories response from "${integration.name}" is not valid.`);
  }
  return parsed.data.categories;
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
