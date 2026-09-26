import type { Database } from "bun:sqlite";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  createProject,
  getProject,
  listProjects,
  setProjectsEnabledExcept,
  updateProject,
  type Project,
} from "../db/repositories/projects";
import {
  projectAgentSchema,
  projectPolicySchema,
  type ProjectAgent,
  type ProjectDefinition,
  type ProjectPolicy,
} from "./config";

export interface ProjectCatalogEntry {
  id: string;
  name: string;
  aliases: string[];
  directory: string;
  defaultBranch: string;
  allowedAgents: ProjectAgent[];
  instructions?: string;
  policy: ProjectPolicy;
  enabled: boolean;
}

const storedProjectDetailsSchema = z.object({
  aliases: z.array(z.string()).default([]),
  allowedAgents: z.array(projectAgentSchema).optional(),
  instructions: z.string().optional(),
  policy: projectPolicySchema.default({ allowPush: true, allowMerge: false, allowDeploy: false }),
});

type StoredProjectDetails = z.infer<typeof storedProjectDetailsSchema>;

const validAgents = new Set<ProjectAgent>(["codex", "claude"]);

/** Return the enabled, typed project catalog for the internal API and UI. */
export function listProjectCatalog(db: Database): ProjectCatalogEntry[] {
  return listProjects(db)
    .filter((project) => project.enabled)
    .map(toCatalogEntry);
}

/** Return an enabled registered project, including its execution policy. */
export function getProjectCatalogEntry(db: Database, id: string): ProjectCatalogEntry | null {
  const project = getProject(db, id);
  return project?.enabled ? toCatalogEntry(project) : null;
}

/** Resolve only a registered ID, name, or alias. Never treat input as a directory path. */
export function resolveProject(
  db: Database,
  input: string | null | undefined
): ProjectCatalogEntry | null {
  const selector = input?.trim();
  if (!selector || looksLikePath(selector)) return null;

  const normalized = selector.toLowerCase();
  return (
    listProjectCatalog(db).find((project) =>
      [project.id, project.name, ...project.aliases].some(
        (registeredName) => registeredName.toLowerCase() === normalized
      )
    ) ?? null
  );
}

/** Replace the enabled catalog rows from a validated project file in one transaction. */
export function syncProjectCatalog(
  db: Database,
  definitions: ProjectDefinition[],
  defaultExecutor: ProjectAgent
): void {
  db.transaction(() => {
    for (const definition of definitions) {
      const executor = definition.allowedAgents.includes(defaultExecutor)
        ? defaultExecutor
        : definition.allowedAgents[0]!;
      const existing = getProject(db, definition.id);
      if (existing) {
        updateProject(db, definition.id, {
          name: definition.name,
          path: definition.directory,
          defaultBranch: definition.defaultBranch,
          executor,
          enabled: true,
          config: storedDetails(definition),
        });
      } else {
        createProject(db, {
          id: definition.id,
          name: definition.name,
          path: definition.directory,
          defaultBranch: definition.defaultBranch,
          executor,
          enabled: true,
          config: storedDetails(definition),
        });
      }
    }
    setProjectsEnabledExcept(
      db,
      definitions.map((definition) => definition.id)
    );
  })();
}

function storedDetails(definition: ProjectDefinition): StoredProjectDetails {
  return {
    aliases: definition.aliases,
    allowedAgents: definition.allowedAgents,
    ...(definition.instructions === undefined ? {} : { instructions: definition.instructions }),
    policy: definition.policy,
  };
}

function toCatalogEntry(project: Project): ProjectCatalogEntry {
  const details = readStoredDetails(project.config);
  const allowedAgents =
    details.allowedAgents ??
    (validAgents.has(project.executor as ProjectAgent) ? [project.executor as ProjectAgent] : []);
  return {
    id: project.id,
    name: project.name,
    aliases: details.aliases ?? [],
    directory: project.path,
    defaultBranch: project.defaultBranch,
    allowedAgents,
    ...(details.instructions === undefined ? {} : { instructions: details.instructions }),
    policy: details.policy,
    enabled: project.enabled,
  };
}

function readStoredDetails(value: unknown): StoredProjectDetails {
  const parsed = storedProjectDetailsSchema.safeParse(value);
  return parsed.success ? parsed.data : storedProjectDetailsSchema.parse({});
}

function looksLikePath(value: string): boolean {
  return (
    isAbsolute(value) ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    /^[a-zA-Z]:/.test(value)
  );
}
