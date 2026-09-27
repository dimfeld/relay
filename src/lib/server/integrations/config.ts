import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  createEventRoute,
  createIntegration,
  getEventRoute,
  getIntegration,
  setEventRoutesEnabledExcept,
  setIntegrationsEnabledExcept,
  updateEventRoute,
  updateIntegration,
} from "../db/repositories/integrations";
import { INTEGRATION_KINDS } from "./types";

const id = z.string().trim().min(1);

const integrationDefinitionSchema = z.object({
  id,
  name: z.string().trim().min(1),
  kind: z.enum(INTEGRATION_KINDS),
  baseUrl: z.url({ protocol: /^https?$/ }),
});

const routeDefinitionSchema = z
  .object({
    id,
    eventType: z.string().trim().min(1).nullable().default(null),
    actionType: z.string().trim().min(1).nullable().default(null),
    integrationId: id,
  })
  .refine((route) => route.eventType !== null || route.actionType !== null, {
    message: "a route must set eventType, actionType, or both",
  });

const integrationsFileSchema = z.object({
  integrations: z.array(integrationDefinitionSchema),
  routes: z.array(routeDefinitionSchema),
});

export type IntegrationDefinition = z.infer<typeof integrationDefinitionSchema>;
export type RouteDefinition = z.infer<typeof routeDefinitionSchema>;
export type IntegrationsFile = z.infer<typeof integrationsFileSchema>;

/** Read and validate the optional integrations file. Return null when it is not configured. */
export function loadIntegrationDefinitions(filePath: string | undefined): IntegrationsFile | null {
  if (!filePath) return null;

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read integration configuration at ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const parsed = integrationsFileSchema.safeParse(value);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.length ? issue.path.join(".") : "file"}: ${issue.message}`
    );
    throw new Error(`Invalid integration configuration at ${filePath}:\n${problems.join("\n")}`);
  }

  const problems = referenceProblems(parsed.data);
  if (problems.length) {
    throw new Error(`Invalid integration configuration at ${filePath}:\n${problems.join("\n")}`);
  }
  return parsed.data;
}

function referenceProblems({ integrations, routes }: IntegrationsFile): string[] {
  const problems: string[] = [];
  const duplicates = (values: string[]) =>
    values.filter((value, index) => values.indexOf(value) !== index);
  for (const value of duplicates(integrations.map((integration) => integration.id))) {
    problems.push(`integrations: ID "${value}" is used more than once`);
  }
  for (const value of duplicates(integrations.map((integration) => integration.name))) {
    problems.push(`integrations: name "${value}" is used more than once`);
  }
  for (const value of duplicates(routes.map((route) => route.id))) {
    problems.push(`routes: ID "${value}" is used more than once`);
  }
  const integrationIds = new Set(integrations.map((integration) => integration.id));
  for (const route of routes) {
    if (!integrationIds.has(route.integrationId)) {
      problems.push(
        `routes: route "${route.id}" names unknown integration "${route.integrationId}"`
      );
    }
  }
  return problems;
}

/**
 * Make the enabled integrations and routes match the file in one transaction. Rows that are not
 * in the file are disabled, not deleted, because delivery history refers to them.
 */
export function syncIntegrationCatalog(db: Database, file: IntegrationsFile): void {
  db.transaction(() => {
    for (const { id, ...fields } of file.integrations) {
      const values = { ...fields, enabled: true, config: {} };
      if (getIntegration(db, id)) updateIntegration(db, id, values);
      else createIntegration(db, { id, ...values });
    }
    for (const { id, ...fields } of file.routes) {
      const values = { ...fields, enabled: true, config: {} };
      if (getEventRoute(db, id)) updateEventRoute(db, id, values);
      else createEventRoute(db, { id, ...values });
    }
    setIntegrationsEnabledExcept(
      db,
      file.integrations.map((integration) => integration.id)
    );
    setEventRoutesEnabledExcept(
      db,
      file.routes.map((route) => route.id)
    );
  })();
}
