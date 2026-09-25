import type { Database } from "bun:sqlite";
import { nowIso, parseJson, serializeJson } from "../json";

export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "dead";

export interface Job<TPayload = unknown> {
  id: string;
  type: string;
  queue: string;
  status: JobStatus;
  payload: TPayload;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  lockedAt: string | null;
  lockedBy: string | null;
  lastError: string | null;
  eventId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: string;
  type: string;
  queue: string;
  status: JobStatus;
  payload: string;
  attempts: number;
  max_attempts: number;
  available_at: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueJobInput<TPayload = unknown> {
  id?: string;
  type: string;
  queue: string;
  payload: TPayload;
  maxAttempts: number;
  availableAt?: string;
  eventId?: string | null;
  createdAt?: string;
}

function mapJob<TPayload>(row: JobRow): Job<TPayload> {
  return {
    id: row.id,
    type: row.type,
    queue: row.queue,
    status: row.status,
    payload: parseJson<TPayload>(row.payload),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    lastError: row.last_error,
    eventId: row.event_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function enqueueJob<TPayload>(
  db: Database,
  input: EnqueueJobInput<TPayload>
): Job<TPayload> {
  const id = input.id ?? crypto.randomUUID();
  const createdAt = input.createdAt ?? nowIso();
  db.query(
    `INSERT INTO jobs
     (id, type, queue, status, payload, attempts, max_attempts, available_at, event_id, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.type,
    input.queue,
    serializeJson(input.payload),
    input.maxAttempts,
    input.availableAt ?? createdAt,
    input.eventId ?? null,
    createdAt,
    createdAt
  );
  return getJob<TPayload>(db, id)!;
}

export function getJob<TPayload = unknown>(db: Database, id: string): Job<TPayload> | null {
  const row = db.query<JobRow, [string]>("SELECT * FROM jobs WHERE id = ?").get(id);
  return row ? mapJob<TPayload>(row) : null;
}

/** Claim one available pending job with a single atomic UPDATE ... RETURNING statement. */
export function claimJob<TPayload = unknown>(
  db: Database,
  workerId: string,
  at = nowIso(),
  queue?: string
): Job<TPayload> | null {
  const sql =
    queue !== undefined
      ? `UPDATE jobs SET status = 'running', locked_at = ?, locked_by = ?, attempts = attempts + 1, updated_at = ?
       WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND queue = ? AND available_at <= ?
                  ORDER BY available_at, created_at LIMIT 1)
       RETURNING *`
      : `UPDATE jobs SET status = 'running', locked_at = ?, locked_by = ?, attempts = attempts + 1, updated_at = ?
       WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND available_at <= ?
                  ORDER BY available_at, created_at LIMIT 1)
       RETURNING *`;
  const row =
    queue !== undefined
      ? db
          .query<JobRow, [string, string, string, string, string]>(sql)
          .get(at, workerId, at, queue, at)
      : db.query<JobRow, [string, string, string, string]>(sql).get(at, workerId, at, at);
  return row ? mapJob<TPayload>(row) : null;
}

export function completeJob<TPayload = unknown>(
  db: Database,
  id: string,
  workerId: string,
  at = nowIso()
): Job<TPayload> | null {
  const row = db
    .query<JobRow, [string, string, string]>(
      `UPDATE jobs SET status = 'succeeded', locked_at = NULL, locked_by = NULL, updated_at = ?
       WHERE id = ? AND status = 'running' AND locked_by = ?
       RETURNING *`
    )
    .get(at, id, workerId);
  return row ? mapJob<TPayload>(row) : null;
}

export function failJob<TPayload = unknown>(
  db: Database,
  id: string,
  workerId: string,
  error: string,
  availableAt = nowIso(),
  retryable = true,
  at = nowIso()
): Job<TPayload> | null {
  // Non-retryable errors become failed; retryable errors become dead after the final attempt.
  const row = db
    .query<JobRow, [number, string, string, string, string, string]>(
      `UPDATE jobs SET
         status = CASE WHEN ? = 0 THEN 'failed'
                       WHEN attempts >= max_attempts THEN 'dead'
                       ELSE 'pending' END,
         available_at = ?, locked_at = NULL, locked_by = NULL, last_error = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND locked_by = ?
       RETURNING *`
    )
    .get(retryable ? 1 : 0, availableAt, error, at, id, workerId);
  return row ? mapJob<TPayload>(row) : null;
}

export function recoverStaleJobs(
  db: Database,
  staleBefore: string,
  at = nowIso(),
  queue?: string
): number {
  const sql =
    queue === undefined
      ? `UPDATE jobs SET
           status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
           available_at = ?, locked_at = NULL, locked_by = NULL,
           last_error = CASE WHEN attempts >= max_attempts THEN 'Job lock went stale.' ELSE last_error END,
           updated_at = ?
         WHERE status = 'running' AND locked_at < ?
         RETURNING id`
      : `UPDATE jobs SET
           status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
           available_at = ?, locked_at = NULL, locked_by = NULL,
           last_error = CASE WHEN attempts >= max_attempts THEN 'Job lock went stale.' ELSE last_error END,
           updated_at = ?
         WHERE status = 'running' AND locked_at < ? AND queue = ?
         RETURNING id`;
  const rows =
    queue === undefined
      ? db.query<{ id: string }, [string, string, string]>(sql).all(at, at, staleBefore)
      : db
          .query<{ id: string }, [string, string, string, string]>(sql)
          .all(at, at, staleBefore, queue);
  return rows.length;
}

export function listJobs<TPayload = unknown>(
  db: Database,
  filters: { status?: JobStatus; queue?: string } = {}
): Job<TPayload>[] {
  const conditions: string[] = [];
  const values: string[] = [];
  if (filters.status !== undefined) {
    conditions.push("status = ?");
    values.push(filters.status);
  }
  if (filters.queue !== undefined) {
    conditions.push("queue = ?");
    values.push(filters.queue);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .query<JobRow, string[]>(`SELECT * FROM jobs ${where} ORDER BY created_at, id`)
    .all(...values);
  return rows.map(mapJob<TPayload>);
}
