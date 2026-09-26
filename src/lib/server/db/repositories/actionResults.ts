import type { Database } from "bun:sqlite";
import { nowIso, parseNullableJson, serializeJson } from "../json";

export interface ActionResult<TResult = unknown> {
  id: string;
  eventId: string;
  actionType: string;
  status: string;
  result: TResult | null;
  error: string | null;
  createdAt: string;
}

interface ActionResultRow {
  id: string;
  event_id: string;
  action_type: string;
  status: string;
  result: string | null;
  error: string | null;
  created_at: string;
}

export interface CreateActionResultInput<TResult = unknown> {
  id?: string;
  eventId: string;
  actionType: string;
  status: string;
  result?: TResult | null;
  error?: string | null;
  createdAt?: string;
}

export type ActionResultUpdate<TResult = unknown> = Partial<
  Pick<ActionResult<TResult>, "status" | "result" | "error">
>;

function mapActionResult<TResult>(row: ActionResultRow): ActionResult<TResult> {
  return {
    id: row.id,
    eventId: row.event_id,
    actionType: row.action_type,
    status: row.status,
    result: parseNullableJson<TResult>(row.result),
    error: row.error,
    createdAt: row.created_at,
  };
}

export function createActionResult<TResult>(
  db: Database,
  input: CreateActionResultInput<TResult>
): ActionResult<TResult> {
  const id = input.id ?? crypto.randomUUID();
  db.query(
    `INSERT INTO action_results (id, event_id, action_type, status, result, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.eventId,
    input.actionType,
    input.status,
    input.result == null ? null : serializeJson(input.result),
    input.error ?? null,
    input.createdAt ?? nowIso()
  );
  return getActionResult<TResult>(db, id)!;
}

export function getActionResult<TResult = unknown>(
  db: Database,
  id: string
): ActionResult<TResult> | null {
  const row = db
    .query<ActionResultRow, [string]>("SELECT * FROM action_results WHERE id = ?")
    .get(id);
  return row ? mapActionResult<TResult>(row) : null;
}

export function listActionResultsForEvent<TResult = unknown>(
  db: Database,
  eventId: string
): ActionResult<TResult>[] {
  return db
    .query<ActionResultRow, [string]>(
      "SELECT * FROM action_results WHERE event_id = ? ORDER BY created_at, id"
    )
    .all(eventId)
    .map(mapActionResult<TResult>);
}

export function updateActionResult<TResult>(
  db: Database,
  id: string,
  patch: ActionResultUpdate<TResult>
): ActionResult<TResult> | null {
  const fields: string[] = [];
  const values: (string | null)[] = [];
  if (patch.status !== undefined) {
    fields.push("status = ?");
    values.push(patch.status);
  }
  if (patch.result !== undefined) {
    fields.push("result = ?");
    values.push(patch.result === null ? null : serializeJson(patch.result));
  }
  if (patch.error !== undefined) {
    fields.push("error = ?");
    values.push(patch.error);
  }
  if (fields.length)
    db.query(`UPDATE action_results SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
  return getActionResult<TResult>(db, id);
}
