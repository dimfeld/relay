import type { Database } from "bun:sqlite";
import { nowIso, parseJson, serializeJson } from "../json";

export interface Project<TConfig = unknown> {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  executor: string;
  enabled: boolean;
  config: TConfig;
  createdAt: string;
  updatedAt: string;
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  default_branch: string;
  executor: string;
  enabled: number;
  config: string;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectInput<TConfig = unknown> {
  id?: string;
  name: string;
  path: string;
  defaultBranch: string;
  executor: string;
  enabled?: boolean;
  config: TConfig;
}

export type ProjectUpdate<TConfig = unknown> = Partial<
  Pick<Project<TConfig>, "name" | "path" | "defaultBranch" | "executor" | "enabled" | "config">
>;

function mapProject<TConfig>(row: ProjectRow): Project<TConfig> {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    defaultBranch: row.default_branch,
    executor: row.executor,
    enabled: row.enabled === 1,
    config: parseJson<TConfig>(row.config),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createProject<TConfig>(
  db: Database,
  input: CreateProjectInput<TConfig>
): Project<TConfig> {
  const id = input.id ?? crypto.randomUUID();
  const timestamp = nowIso();
  db.query(
    `INSERT INTO projects
     (id, name, path, default_branch, executor, enabled, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    input.path,
    input.defaultBranch,
    input.executor,
    input.enabled === false ? 0 : 1,
    serializeJson(input.config),
    timestamp,
    timestamp
  );
  return getProject<TConfig>(db, id)!;
}

export function getProject<TConfig = unknown>(db: Database, id: string): Project<TConfig> | null {
  const row = db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(id);
  return row ? mapProject<TConfig>(row) : null;
}

export function updateProject<TConfig>(
  db: Database,
  id: string,
  patch: ProjectUpdate<TConfig>
): Project<TConfig> | null {
  const fields: string[] = [];
  const values: (string | number)[] = [];
  if (patch.name !== undefined) {
    fields.push("name = ?");
    values.push(patch.name);
  }
  if (patch.path !== undefined) {
    fields.push("path = ?");
    values.push(patch.path);
  }
  if (patch.defaultBranch !== undefined) {
    fields.push("default_branch = ?");
    values.push(patch.defaultBranch);
  }
  if (patch.executor !== undefined) {
    fields.push("executor = ?");
    values.push(patch.executor);
  }
  if (patch.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(patch.enabled ? 1 : 0);
  }
  if (patch.config !== undefined) {
    fields.push("config = ?");
    values.push(serializeJson(patch.config));
  }
  if (fields.length) {
    fields.push("updated_at = ?");
    values.push(nowIso());
    db.query(`UPDATE projects SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
  }
  return getProject<TConfig>(db, id);
}
