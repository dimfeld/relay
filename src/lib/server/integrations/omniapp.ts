import type { Integration } from "../db/repositories/integrations";
import { fetchTransport, postJson, requireObjectId } from "./http";
import type { DeliveryEnvelope, HttpTransport, OwnerAdapter } from "./types";

const OMNIAPP_ENDPOINTS = {
  "package.detected": "packages/detected",
  "note.create": "notes",
  "note.append": "notes/append",
} as const;
const OMNIAPP_RESPONSE_ID_FIELD = "id";

/**
 * OmniApp's request field names and endpoints are provisional until its receiver contract is
 * agreed. Keep the mapping here so that contract changes stay within this adapter.
 */
function omniAppRequest(envelope: DeliveryEnvelope): { path: string; body: unknown } {
  const payload = envelope.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(
      `OmniApp cannot deliver ${envelope.actionType}: action payload must be an object.`
    );
  }
  const action = payload as Record<string, unknown>;

  switch (envelope.actionType) {
    case "package.detected":
      return {
        path: OMNIAPP_ENDPOINTS["package.detected"],
        body: { ...action, sourceEventId: envelope.eventId },
      };
    case "note.create":
      return {
        path: OMNIAPP_ENDPOINTS["note.create"],
        body: {
          title: action.title,
          body: action.body,
          topic: action.topic,
          sourceEventId: envelope.eventId,
        },
      };
    case "note.append":
      return {
        path: OMNIAPP_ENDPOINTS["note.append"],
        body: {
          body: action.body,
          targetId: action.targetId,
          contextEventId: action.contextEventId,
          sourceEventId: envelope.eventId,
        },
      };
    default:
      throw new Error(`OmniApp does not support action type ${envelope.actionType}.`);
  }
}

export function createOmniAppAdapter(transport: HttpTransport = fetchTransport): OwnerAdapter {
  return {
    kind: "omniapp",
    supportedActionTypes: Object.keys(OMNIAPP_ENDPOINTS),
    async deliver(integration: Integration, envelope: DeliveryEnvelope) {
      const { path, body } = omniAppRequest(envelope);
      const response = await postJson({ integration, envelope, path, body, transport });
      const downstreamId = requireObjectId(
        response,
        OMNIAPP_RESPONSE_ID_FIELD,
        `OmniApp response for ${envelope.actionType} did not include an object id.`
      );
      return { downstreamId, response };
    },
  };
}
