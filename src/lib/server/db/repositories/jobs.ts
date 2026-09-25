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
  at = nowIso()
): Job<TPayload> | null {
  db.query(
    `UPDATE jobs SET status = 'succeeded', locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?`
  ).run(at, id);
  return getJob<TPayload>(db, id);
}

export function failJob<TPayload = unknown>(
  db: Database,
  id: string,
  error: string,
  availableAt = nowIso()
): Job<TPayload> | null {
  const job = getJob<TPayload>(db, id);
  if (!job) return null;
  const status: JobStatus = job.attempts >= job.maxAttempts ? "dead" : "pending";
  db.query(
    `UPDATE jobs SET status = ?, available_at = ?, locked_at = NULL, locked_by = NULL,
       last_error = ?, updated_at = ? WHERE id = ?`
  ).run(status, availableAt, error, nowIso(), id);
  return getJob<TPayload>(db, id);
}
