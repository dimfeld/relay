import type { Database } from "bun:sqlite";
import { nowIso, parseNullableJson, serializeJson } from "../json";

export interface ProcessingAttempt {
  id: string;
  eventId: string;
  stage: string;
  status: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  details: unknown | null;
}

interface AttemptRow {
  id: string;
  event_id: string;
  stage: string;
  status: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  details: string | null;
}

export interface CreateAttemptInput {
  id?: string;
  eventId: string;
  stage: string;
  status: string;
  error?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
  details?: unknown | null;
}

export type AttemptUpdate = Partial<
  Pick<ProcessingAttempt, "status" | "error" | "finishedAt" | "details">
>;

function mapAttempt(row: AttemptRow): ProcessingAttempt {
  return {
    id: row.id,
    eventId: row.event_id,
    stage: row.stage,
    status: row.status,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    details: parseNullableJson(row.details),
  };
}

export function createAttempt(db: Database, input: CreateAttemptInput): ProcessingAttempt {
  const id = input.id ?? crypto.randomUUID();
  db.query(
    `INSERT INTO processing_attempts (id, event_id, stage, status, error, started_at, finished_at, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.eventId,
    input.stage,
    input.status,
    input.error ?? null,
    input.startedAt ?? nowIso(),
    input.finishedAt ?? null,
    input.details == null ? null : serializeJson(input.details)
  );
  return getAttempt(db, id)!;
}

export function getAttempt(db: Database, id: string): ProcessingAttempt | null {
  const row = db
    .query<AttemptRow, [string]>("SELECT * FROM processing_attempts WHERE id = ?")
    .get(id);
  return row ? mapAttempt(row) : null;
}

export function listAttemptsForEvent(db: Database, eventId: string): ProcessingAttempt[] {
  return db
    .query<AttemptRow, [string]>(
      "SELECT * FROM processing_attempts WHERE event_id = ? ORDER BY started_at"
    )
    .all(eventId)
    .map(mapAttempt);
}

export function updateAttempt(
  db: Database,
  id: string,
  patch: AttemptUpdate
): ProcessingAttempt | null {
  const fields: string[] = [];
  const values: (string | null)[] = [];
  if (patch.status !== undefined) {
    fields.push("status = ?");
    values.push(patch.status);
  }
  if (patch.error !== undefined) {
    fields.push("error = ?");
    values.push(patch.error);
  }
  if (patch.finishedAt !== undefined) {
    fields.push("finished_at = ?");
    values.push(patch.finishedAt);
  }
  if (patch.details !== undefined) {
    fields.push("details = ?");
    values.push(patch.details === null ? null : serializeJson(patch.details));
  }
  if (fields.length)
    db.query(`UPDATE processing_attempts SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
  return getAttempt(db, id);
}
