import { authenticateService, hasCapability, type ServiceIdentity } from "../auth";
import type { ServiceCapability } from "../config";
import type { ServerContext } from "../context";

export function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** Return the calling service, or the 401/403 response when it may not make the request. */
export function authorize(
  context: ServerContext,
  request: Request,
  capability: ServiceCapability
): ServiceIdentity | Response {
  const identity = authenticateService(
    context.config.INTERNAL_SERVICE_CREDENTIALS,
    request.headers.get("authorization")
  );
  if (!identity) return errorResponse(401, "Unauthorized");
  if (!hasCapability(identity, capability)) {
    return errorResponse(403, `Service lacks the ${capability} capability.`);
  }
  return identity;
}
