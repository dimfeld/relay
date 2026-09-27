import type { Handle, ServerInit } from "@sveltejs/kit";
import { getServerContext } from "$lib/server/context";
import { log } from "$lib/server/logging";
import { startBackgroundWorkers } from "$lib/server/runtime";

/** The internal server runs the queue workers. The public webhook listener only accepts captures. */
export const init: ServerInit = () => {
  const workers = startBackgroundWorkers(getServerContext());
  log("info", "queue workers started", { queues: Object.keys(workers.workers).join(", ") });
  process.once("sveltekit:shutdown", () => void workers.stop());
};

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
