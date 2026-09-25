import type { Database } from "bun:sqlite";
import { nowIso, parseJson, serializeJson } from "../json";

export interface Classification {
  id: string;
  eventId: string;
  actionType: string;
  result: unknown;
  provider: string;
  model: string;
  confidence: number | null;
  status: string;
  error: string | null;
  createdAt: string;
}

interface ClassificationRow {
  id: string;
  event_id: string;
  action_type: string;
  result: string;
  provider: string;
  model: string;
  confidence: number | null;
  status: string;
  error: string | null;
  created_at: string;
}

export type CreateClassificationInput = Omit<Classification, "id" | "createdAt"> & {
  id?: string;
  createdAt?: string;
};
export type ClassificationUpdate = Partial<
  Pick<Classification, "result" | "confidence" | "status" | "error">
>;

function mapClassification(row: ClassificationRow): Classification {
  return {
    id: row.id,
    eventId: row.event_id,
    actionType: row.action_type,
    result: parseJson(row.result),
    provider: row.provider,
    model: row.model,
    confidence: row.confidence,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
  };
}

export function createClassification(
  db: Database,
  input: CreateClassificationInput
): Classification {
  const id = input.id ?? crypto.randomUUID();
  db.query(
    `INSERT INTO classifications
     (id, event_id, action_type, result, provider, model, confidence, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.eventId,
    input.actionType,
    serializeJson(input.result),
    input.provider,
    input.model,
    input.confidence,
    input.status,
    input.error,
    input.createdAt ?? nowIso()
  );
  return getClassification(db, id)!;
}

export function getClassification(db: Database, id: string): Classification | null {
  const row = db
    .query<ClassificationRow, [string]>("SELECT * FROM classifications WHERE id = ?")
    .get(id);
  return row ? mapClassification(row) : null;
}

export function updateClassification(
  db: Database,
  id: string,
  patch: ClassificationUpdate
): Classification | null {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.result !== undefined) {
    fields.push("result = ?");
    values.push(serializeJson(patch.result));
  }
  if (patch.confidence !== undefined) {
    fields.push("confidence = ?");
    values.push(patch.confidence);
  }
  if (patch.status !== undefined) {
    fields.push("status = ?");
    values.push(patch.status);
  }
  if (patch.error !== undefined) {
    fields.push("error = ?");
    values.push(patch.error);
  }
  if (fields.length)
    db.query(`UPDATE classifications SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
  return getClassification(db, id);
}
