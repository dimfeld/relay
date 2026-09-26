import { hasCapability } from "../auth";
import type { ServerContext } from "../context";
import { eventEnvelopeSchema, publishEvent, requiredCapabilities } from "../events/internal";
import { log } from "../logging";
import { readBodyWithinLimit } from "../request";
import { authorize, errorResponse } from "./authorize";

/** Handle POST /api/events on the internal listener. */
export async function handlePublishEvent(
  context: ServerContext,
  request: Request,
  correlationId: string
): Promise<Response> {
  const identity = authorize(context, request, "events:publish");
  if (identity instanceof Response) return identity;

  const maxBytes = context.config.INTERNAL_API_MAX_BODY_BYTES;
  const contentLength = request.headers.get("content-length");
  const body =
    contentLength !== null && Number(contentLength) > maxBytes
      ? null
      : await readBodyWithinLimit(request, maxBytes);
  if (body === null) return errorResponse(413, "Request body is too large");

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return errorResponse(400, "Request body must be JSON.");
  }
  const parsed = eventEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "body"}: ${issue.message}`
    );
    return errorResponse(400, `Invalid event envelope. ${problems.join("; ")}`);
  }
  const envelope = parsed.data;

  if (envelope.source !== identity.name) {
    return errorResponse(403, `Service ${identity.name} cannot publish as ${envelope.source}.`);
  }
  const missing = requiredCapabilities(envelope.type).find(
    (capability) => !hasCapability(identity, capability)
  );
  if (missing) {
    return errorResponse(403, `Service lacks the ${missing} capability for ${envelope.type}.`);
  }

  const result = publishEvent(
    context.db,
    envelope,
    request.headers.get("idempotency-key"),
    correlationId
  );
  log("info", "internal event published", {
    correlationId,
    service: identity.name,
    type: envelope.type,
    eventId: result.eventId,
    duplicate: result.duplicate,
  });
  return result.duplicate
    ? Response.json({ eventId: result.eventId, duplicate: true }, { status: 200 })
    : Response.json({ eventId: result.eventId }, { status: 202 });
}
