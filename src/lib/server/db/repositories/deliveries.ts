import type { Database } from "bun:sqlite";
import { nowIso, parseJson, parseNullableJson, serializeJson } from "../json";

export type DeliveryStatus = "pending" | "succeeded" | "failed" | "dead";

export interface Delivery<TRequest = unknown, TResponse = unknown> {
  id: string;
  eventId: string;
  integrationId: string;
  routeId: string | null;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  idempotencyKey: string;
  request: TRequest;
  response: TResponse | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DeliveryRow {
  id: string;
  event_id: string;
  integration_id: string;
  route_id: string | null;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string | null;
  idempotency_key: string;
  request: string;
  response: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateDeliveryInput<TRequest = unknown> {
  id?: string;
  eventId: string;
  integrationId: string;
  routeId?: string | null;
  status?: DeliveryStatus;
  attempts?: number;
  nextAttemptAt?: string | null;
  idempotencyKey: string;
  request: TRequest;
}

export type DeliveryUpdate<TResponse = unknown> = Partial<
  Pick<
    Delivery<unknown, TResponse>,
    "status" | "attempts" | "nextAttemptAt" | "response" | "lastError"
  >
>;

function mapDelivery<TRequest, TResponse>(row: DeliveryRow): Delivery<TRequest, TResponse> {
  return {
    id: row.id,
    eventId: row.event_id,
    integrationId: row.integration_id,
    routeId: row.route_id,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    idempotencyKey: row.idempotency_key,
    request: parseJson<TRequest>(row.request),
    response: parseNullableJson<TResponse>(row.response),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createDelivery<TRequest, TResponse = unknown>(
  db: Database,
  input: CreateDeliveryInput<TRequest>
): Delivery<TRequest, TResponse> {
  const id = input.id ?? crypto.randomUUID();
  const timestamp = nowIso();
  db.query(
    `INSERT INTO deliveries
     (id, event_id, integration_id, route_id, status, attempts, next_attempt_at, idempotency_key,
      request, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.eventId,
    input.integrationId,
    input.routeId ?? null,
    input.status ?? "pending",
    input.attempts ?? 0,
    input.nextAttemptAt ?? timestamp,
    input.idempotencyKey,
    serializeJson(input.request),
    timestamp,
    timestamp
  );
  return getDelivery<TRequest, TResponse>(db, id)!;
}

export function getDelivery<TRequest = unknown, TResponse = unknown>(
  db: Database,
  id: string
): Delivery<TRequest, TResponse> | null {
  const row = db.query<DeliveryRow, [string]>("SELECT * FROM deliveries WHERE id = ?").get(id);
  return row ? mapDelivery<TRequest, TResponse>(row) : null;
}

export function findDeliveryByIdempotencyKey<TRequest = unknown, TResponse = unknown>(
  db: Database,
  idempotencyKey: string
): Delivery<TRequest, TResponse> | null {
  const row = db
    .query<DeliveryRow, [string]>("SELECT * FROM deliveries WHERE idempotency_key = ?")
    .get(idempotencyKey);
  return row ? mapDelivery<TRequest, TResponse>(row) : null;
}

export function updateDelivery<TResponse>(
  db: Database,
  id: string,
  patch: DeliveryUpdate<TResponse>
): Delivery<unknown, TResponse> | null {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.status !== undefined) {
    fields.push("status = ?");
    values.push(patch.status);
  }
  if (patch.attempts !== undefined) {
    fields.push("attempts = ?");
    values.push(patch.attempts);
  }
  if (patch.nextAttemptAt !== undefined) {
    fields.push("next_attempt_at = ?");
    values.push(patch.nextAttemptAt);
  }
  if (patch.response !== undefined) {
    fields.push("response = ?");
    values.push(patch.response === null ? null : serializeJson(patch.response));
  }
  if (patch.lastError !== undefined) {
    fields.push("last_error = ?");
    values.push(patch.lastError);
  }
  if (fields.length) {
    fields.push("updated_at = ?");
    values.push(nowIso());
    db.query(`UPDATE deliveries SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
  }
  return getDelivery<unknown, TResponse>(db, id);
}
