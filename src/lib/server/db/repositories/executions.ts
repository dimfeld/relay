import type { Database } from "bun:sqlite";
import { nowIso } from "../json";

export type ExecutionStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Execution {
  id: string;
  projectId: string;
  eventId: string | null;
  executor: string;
  status: ExecutionStatus;
  prompt: string;
  instructions: string | null;
  branch: string | null;
  commitSha: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionLog {
  id: string;
  executionId: string;
  seq: number;
  ts: string;
  stream: string;
  level: string | null;
  message: string;
}

interface ExecutionRow {
  id: string;
  project_id: string;
  event_id: string | null;
  executor: string;
  status: ExecutionStatus;
  prompt: string;
  instructions: string | null;
  branch: string | null;
  commit_sha: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface ExecutionLogRow {
  id: string;
  execution_id: string;
  seq: number;
  ts: string;
  stream: string;
  level: string | null;
  message: string;
}

export interface CreateExecutionInput {
  id?: string;
  projectId: string;
  eventId?: string | null;
  executor: string;
  status?: ExecutionStatus;
  prompt: string;
  instructions?: string | null;
  branch?: string | null;
  commitSha?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
}

export type ExecutionUpdate = Partial<
  Pick<
    Execution,
    | "status"
    | "prompt"
    | "instructions"
    | "branch"
    | "commitSha"
    | "startedAt"
    | "finishedAt"
    | "error"
  >
>;

export interface CreateExecutionLogInput {
  id?: string;
  executionId: string;
  seq: number;
  ts?: string;
  stream: string;
  level?: string | null;
  message: string;
}

function mapExecution(row: ExecutionRow): Execution {
  return {
    id: row.id,
    projectId: row.project_id,
    eventId: row.event_id,
    executor: row.executor,
    status: row.status,
    prompt: row.prompt,
    instructions: row.instructions,
    branch: row.branch,
    commitSha: row.commit_sha,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapExecutionLog(row: ExecutionLogRow): ExecutionLog {
  return {
    id: row.id,
    executionId: row.execution_id,
    seq: row.seq,
    ts: row.ts,
    stream: row.stream,
    level: row.level,
    message: row.message,
  };
}

export function createExecution(db: Database, input: CreateExecutionInput): Execution {
  const id = input.id ?? crypto.randomUUID();
  const timestamp = nowIso();
  db.query(
    `INSERT INTO executions
     (id, project_id, event_id, executor, status, prompt, instructions, branch, commit_sha,
      started_at, finished_at, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.projectId,
    input.eventId ?? null,
    input.executor,
    input.status ?? "queued",
    input.prompt,
    input.instructions ?? null,
    input.branch ?? null,
    input.commitSha ?? null,
    input.startedAt ?? null,
    input.finishedAt ?? null,
    input.error ?? null,
    timestamp,
    timestamp
  );
  return getExecution(db, id)!;
}

export function getExecution(db: Database, id: string): Execution | null {
  const row = db.query<ExecutionRow, [string]>("SELECT * FROM executions WHERE id = ?").get(id);
  return row ? mapExecution(row) : null;
}

export function listExecutionsForProject(db: Database, projectId: string): Execution[] {
  return db
    .query<ExecutionRow, [string]>(
      "SELECT * FROM executions WHERE project_id = ? ORDER BY created_at"
    )
    .all(projectId)
    .map(mapExecution);
}

export function updateExecution(
  db: Database,
  id: string,
  patch: ExecutionUpdate
): Execution | null {
  const fields: string[] = [];
  const values: (string | null)[] = [];
  if (patch.status !== undefined) {
    fields.push("status = ?");
    values.push(patch.status);
  }
  if (patch.prompt !== undefined) {
    fields.push("prompt = ?");
    values.push(patch.prompt);
  }
  if (patch.instructions !== undefined) {
    fields.push("instructions = ?");
    values.push(patch.instructions);
  }
  if (patch.branch !== undefined) {
    fields.push("branch = ?");
    values.push(patch.branch);
  }
  if (patch.commitSha !== undefined) {
    fields.push("commit_sha = ?");
    values.push(patch.commitSha);
  }
  if (patch.startedAt !== undefined) {
    fields.push("started_at = ?");
    values.push(patch.startedAt);
  }
  if (patch.finishedAt !== undefined) {
    fields.push("finished_at = ?");
    values.push(patch.finishedAt);
  }
  if (patch.error !== undefined) {
    fields.push("error = ?");
    values.push(patch.error);
  }
  if (fields.length) {
    fields.push("updated_at = ?");
    values.push(nowIso());
    db.query(`UPDATE executions SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
  }
  return getExecution(db, id);
}

export function appendExecutionLog(db: Database, input: CreateExecutionLogInput): ExecutionLog {
  const id = input.id ?? crypto.randomUUID();
  db.query(
    `INSERT INTO execution_logs (id, execution_id, seq, ts, stream, level, message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.executionId,
    input.seq,
    input.ts ?? nowIso(),
    input.stream,
    input.level ?? null,
    input.message
  );
  return getExecutionLog(db, id)!;
}

export function getExecutionLog(db: Database, id: string): ExecutionLog | null {
  const row = db
    .query<ExecutionLogRow, [string]>("SELECT * FROM execution_logs WHERE id = ?")
    .get(id);
  return row ? mapExecutionLog(row) : null;
}

export function listExecutionLogs(db: Database, executionId: string): ExecutionLog[] {
  return db
    .query<ExecutionLogRow, [string]>(
      "SELECT * FROM execution_logs WHERE execution_id = ? ORDER BY seq"
    )
    .all(executionId)
    .map(mapExecutionLog);
}
