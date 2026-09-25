import type { Database } from "bun:sqlite";
import { nowIso, parseJson, serializeJson } from "../json";

export interface Integration<TConfig = unknown> {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  enabled: boolean;
  config: TConfig;
  createdAt: string;
  updatedAt: string;
}

export interface EventRoute<TConfig = unknown> {
  id: string;
  eventType: string | null;
  actionType: string | null;
  integrationId: string;
  enabled: boolean;
  config: TConfig;
  createdAt: string;
  updatedAt: string;
}

interface IntegrationRow {
  id: string;
  name: string;
  kind: string;
  base_url: string | null;
  enabled: number;
  config: string;
  created_at: string;
  updated_at: string;
}

interface RouteRow {
  id: string;
  event_type: string | null;
  action_type: string | null;
  integration_id: string;
  enabled: number;
  config: string;
  created_at: string;
  updated_at: string;
}

export interface CreateIntegrationInput<TConfig = unknown> {
  id?: string;
  name: string;
  kind: string;
  baseUrl?: string | null;
  enabled?: boolean;
  config: TConfig;
}

export type IntegrationUpdate<TConfig = unknown> = Partial<
  Pick<Integration<TConfig>, "name" | "kind" | "baseUrl" | "enabled" | "config">
>;

export interface CreateRouteInput<TConfig = unknown> {
  id?: string;
  eventType?: string | null;
  actionType?: string | null;
  integrationId: string;
  enabled?: boolean;
  config: TConfig;
}

export type RouteUpdate<TConfig = unknown> = Partial<
  Pick<EventRoute<TConfig>, "eventType" | "actionType" | "integrationId" | "enabled" | "config">
>;

function mapIntegration<TConfig>(row: IntegrationRow): Integration<TConfig> {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    enabled: row.enabled === 1,
    config: parseJson<TConfig>(row.config),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRoute<TConfig>(row: RouteRow): EventRoute<TConfig> {
  return {
    id: row.id,
    eventType: row.event_type,
    actionType: row.action_type,
    integrationId: row.integration_id,
    enabled: row.enabled === 1,
    config: parseJson<TConfig>(row.config),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createIntegration<TConfig>(
  db: Database,
  input: CreateIntegrationInput<TConfig>
): Integration<TConfig> {
  const id = input.id ?? crypto.randomUUID();
  const timestamp = nowIso();
  db.query(
    `INSERT INTO integrations (id, name, kind, base_url, enabled, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    input.kind,
    input.baseUrl ?? null,
    input.enabled === false ? 0 : 1,
    serializeJson(input.config),
    timestamp,
    timestamp
  );
  return getIntegration<TConfig>(db, id)!;
}

export function getIntegration<TConfig = unknown>(
  db: Database,
  id: string
): Integration<TConfig> | null {
  const row = db.query<IntegrationRow, [string]>("SELECT * FROM integrations WHERE id = ?").get(id);
  return row ? mapIntegration<TConfig>(row) : null;
}

export function updateIntegration<TConfig>(
  db: Database,
  id: string,
  patch: IntegrationUpdate<TConfig>
): Integration<TConfig> | null {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.name !== undefined) {
    fields.push("name = ?");
    values.push(patch.name);
  }
  if (patch.kind !== undefined) {
    fields.push("kind = ?");
    values.push(patch.kind);
  }
  if (patch.baseUrl !== undefined) {
    fields.push("base_url = ?");
    values.push(patch.baseUrl);
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
    db.query(`UPDATE integrations SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
  }
  return getIntegration<TConfig>(db, id);
}

export function createEventRoute<TConfig>(
  db: Database,
  input: CreateRouteInput<TConfig>
): EventRoute<TConfig> {
  const id = input.id ?? crypto.randomUUID();
  const timestamp = nowIso();
  db.query(
    `INSERT INTO event_routes
     (id, event_type, action_type, integration_id, enabled, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.eventType ?? null,
    input.actionType ?? null,
    input.integrationId,
    input.enabled === false ? 0 : 1,
    serializeJson(input.config),
    timestamp,
    timestamp
  );
  return getEventRoute<TConfig>(db, id)!;
}

export function getEventRoute<TConfig = unknown>(
  db: Database,
  id: string
): EventRoute<TConfig> | null {
  const row = db.query<RouteRow, [string]>("SELECT * FROM event_routes WHERE id = ?").get(id);
  return row ? mapRoute<TConfig>(row) : null;
}

export function updateEventRoute<TConfig>(
  db: Database,
  id: string,
  patch: RouteUpdate<TConfig>
): EventRoute<TConfig> | null {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.eventType !== undefined) {
    fields.push("event_type = ?");
    values.push(patch.eventType);
  }
  if (patch.actionType !== undefined) {
    fields.push("action_type = ?");
    values.push(patch.actionType);
  }
  if (patch.integrationId !== undefined) {
    fields.push("integration_id = ?");
    values.push(patch.integrationId);
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
    db.query(`UPDATE event_routes SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
  }
  return getEventRoute<TConfig>(db, id);
}
