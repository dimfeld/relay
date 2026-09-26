import type { Handle } from "@sveltejs/kit";
import { log } from "$lib/server/logging";

export const handle: Handle = async ({ event, resolve }) => {
  const correlationId = crypto.randomUUID();
  event.locals.correlationId = correlationId;
  const response = await resolve(event);
  response.headers.set("x-correlation-id", correlationId);
  log("info", "internal request", {
    correlationId,
    method: event.request.method,
    path: event.url.pathname,
    status: response.status,
  });
  return response;
};
