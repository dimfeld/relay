import type { Database } from "bun:sqlite";
import {
  getIntegration,
  listEnabledEventRoutes,
  type EventRoute,
  type Integration,
} from "../db/repositories/integrations";

export interface RouteQuery {
  eventType?: string | null;
  actionType?: string | null;
}

export interface ResolvedRoute {
  route: EventRoute;
  integration: Integration;
}

/**
 * Match the fields that are present on a route. An exact event-and-action match wins over a
 * route that matches only one field. Ties use the lexicographically first route ID so the
 * same configuration always selects the same owner.
 */
export function resolveRoute(db: Database, query: RouteQuery): ResolvedRoute | null {
  const matching = listEnabledEventRoutes(db)
    .filter((route) => {
      if (route.eventType !== null && route.eventType !== query.eventType) return false;
      if (route.actionType !== null && route.actionType !== query.actionType) return false;
      return true;
    })
    .map((route) => ({ route, integration: getIntegration(db, route.integrationId) }))
    .filter(
      (candidate): candidate is { route: EventRoute; integration: Integration } =>
        candidate.integration !== null && candidate.integration.enabled
    );

  matching.sort((left, right) => {
    const leftSpecificity =
      Number(left.route.eventType !== null) + Number(left.route.actionType !== null);
    const rightSpecificity =
      Number(right.route.eventType !== null) + Number(right.route.actionType !== null);
    return rightSpecificity - leftSpecificity || left.route.id.localeCompare(right.route.id);
  });

  return matching[0] ?? null;
}
