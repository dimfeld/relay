import type { Database } from "bun:sqlite";
import { nowIso, parseJson, serializeJson } from "../json";

export interface ConfigurationEntry<TValue = unknown> {
  key: string;
  value: TValue;
  updatedAt: string;
}

interface ConfigurationRow {
  key: string;
  value: string;
  updated_at: string;
}

function mapEntry<TValue>(row: ConfigurationRow): ConfigurationEntry<TValue> {
  return { key: row.key, value: parseJson<TValue>(row.value), updatedAt: row.updated_at };
}

export function setConfiguration<TValue>(
  db: Database,
  key: string,
  value: TValue
): ConfigurationEntry<TValue> {
  const updatedAt = nowIso();
  db.query(
    `INSERT INTO configuration (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, serializeJson(value), updatedAt);
  return getConfiguration<TValue>(db, key)!;
}

export function getConfiguration<TValue = unknown>(
  db: Database,
  key: string
): ConfigurationEntry<TValue> | null {
  const row = db
    .query<ConfigurationRow, [string]>("SELECT * FROM configuration WHERE key = ?")
    .get(key);
  return row ? mapEntry<TValue>(row) : null;
}

export function deleteConfiguration(db: Database, key: string): boolean {
  return db.query("DELETE FROM configuration WHERE key = ?").run(key).changes > 0;
}
