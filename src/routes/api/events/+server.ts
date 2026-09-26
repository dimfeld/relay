import { getServerContext } from "$lib/server/context";
import { handleAdminRead, loadEvents } from "$lib/server/api/admin";
import { handlePublishEvent } from "$lib/server/api/events";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ request, locals }) =>
  handlePublishEvent(getServerContext(), request, locals.correlationId);

export const GET: RequestHandler = ({ request }) =>
  handleAdminRead(getServerContext(), request, loadEvents);
