import type { Database } from "bun:sqlite";
import { AdminActionError } from "../admin-error";
import type { ServiceIdentity } from "../auth";
import type { RequestContext } from "../context";
import { listAttemptsForEvent, listRecentAttempts } from "../db/repositories/attempts";
import {
  getDelivery,
  listDeliveriesForEvent,
  listRecentDeliveries,
} from "../db/repositories/deliveries";
import { getEvent, listRecentEvents } from "../db/repositories/events";
import {
  getExecution,
  listExecutionLogs,
  listRecentExecutions,
} from "../db/repositories/executions";
import { listFailures } from "../failures";
import {
  getProjectCatalogEntry,
  listProjectCatalog,
  type ProjectCatalogEntry,
} from "../projects/catalog";
import { authorize, errorResponse } from "./authorize";

/** Load the response data. Return null when the requested record does not exist. */
export type AdminLoader<T = unknown> = (db: Database, limit: number | undefined) => T | null;

/** Handle an admin GET request that needs the admin:read capability. */
export function handleAdminRead(
  context: RequestContext,
  request: Request,
  load: AdminLoader
): Response {
  const identity = authorize(context, request, "admin:read");
  if (identity instanceof Response) return identity;

  const limitValue = new URL(request.url).searchParams.get("limit");
  const limit = limitValue === null ? undefined : Number(limitValue);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    return errorResponse(400, "limit must be a positive integer.");
  }

  const data = load(context.db, limit);
  return data === null ? errorResponse(404, "Not found") : Response.json(data);
}

/**
 * Handle an admin POST request that changes how an event is processed, such as a retry,
 * correction, or reclassification. It needs the admin:retry capability.
 */
export async function handleAdminAction(
  context: RequestContext,
  request: Request,
  run: (db: Database, identity: ServiceIdentity) => unknown
): Promise<Response> {
  const identity = authorize(context, request, "admin:retry");
  if (identity instanceof Response) return identity;

  try {
    return Response.json(await run(context.db, identity), { status: 202 });
  } catch (error) {
    if (error instanceof AdminActionError) return errorResponse(error.status, error.message);
    throw error;
  }
}

export const loadEvents: AdminLoader = (db, limit) => ({ events: listRecentEvents(db, limit) });

export function loadEvent(id: string): AdminLoader {
  return (db) => {
    const event = getEvent(db, id);
    if (!event) return null;
    return {
      event,
      attempts: listAttemptsForEvent(db, id),
      deliveries: listDeliveriesForEvent(db, id),
    };
  };
}

export const loadAttempts: AdminLoader = (db, limit) => ({
  attempts: listRecentAttempts(db, limit),
});

export const loadDeliveries: AdminLoader = (db, limit) => ({
  deliveries: listRecentDeliveries(db, limit),
});

export function loadDelivery(id: string): AdminLoader {
  return (db) => {
    const delivery = getDelivery(db, id);
    return delivery && { delivery };
  };
}

export const loadExecutions: AdminLoader = (db, limit) => ({
  executions: listRecentExecutions(db, limit),
});

export function loadExecution(id: string): AdminLoader {
  return (db) => {
    const execution = getExecution(db, id);
    return execution && { execution, logs: listExecutionLogs(db, id) };
  };
}

export const loadProjects: AdminLoader<{ projects: ProjectCatalogEntry[] }> = (db) => ({
  projects: listProjectCatalog(db),
});

export function loadProject(id: string): AdminLoader<{ project: ProjectCatalogEntry } | null> {
  return (db) => {
    const project = getProjectCatalogEntry(db, id);
    return project && { project };
  };
}

export const loadFailures: AdminLoader = (db) => listFailures(db);
