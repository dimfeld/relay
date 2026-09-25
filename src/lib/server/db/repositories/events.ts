import type { Database } from "bun:sqlite";
import { nowIso, parseJson, parseNullableJson, serializeJson } from "../json";

export interface IncomingEvent {
  id: string;
  source: string;
  sourceEventId: string | null;
  type: string;
  receivedAt: string;
  payload: unknown;
  text: string | null;
  metadata: Record<string, unknown> | null;
}

export interface CreateEventInput {
  id?: string;
  source: string;
  sourceEventId?: string | null;
  type: string;
  receivedAt?: string;
  payload: unknown;
  text?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface EventRow {
  id: string;
  source: string;
  source_event_id: string | null;
  type: string;
  received_at: string;
  payload: string;
  text: string | null;
  metadata: string | null;
}

function mapEvent(row: EventRow): IncomingEvent {
  return {
    id: row.id,
    source: row.source,
    sourceEventId: row.source_event_id,
    type: row.type,
    receivedAt: row.received_at,
    payload: parseJson(row.payload),
    text: row.text,
    metadata: parseNullableJson(row.metadata),
  };
}

/** Duplicate (source, sourceEventId) pairs are rejected by the database unique constraint. */
export function createEvent(db: Database, input: CreateEventInput): IncomingEvent {
  const id = input.id ?? crypto.randomUUID();
  const receivedAt = input.receivedAt ?? nowIso();
  db.query(
    `INSERT INTO incoming_events (id, source, source_event_id, type, received_at, payload, text, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.source,
    input.sourceEventId ?? null,
    input.type,
    receivedAt,
    serializeJson(input.payload),
    input.text ?? null,
    input.metadata == null ? null : serializeJson(input.metadata)
  );
  return getEvent(db, id)!;
}

export function getEvent(db: Database, id: string): IncomingEvent | null {
  const row = db.query<EventRow, [string]>("SELECT * FROM incoming_events WHERE id = ?").get(id);
  return row ? mapEvent(row) : null;
}

export function findEventBySource(
  db: Database,
  source: string,
  sourceEventId: string
): IncomingEvent | null {
  const row = db
    .query<EventRow, [string, string]>(
      "SELECT * FROM incoming_events WHERE source = ? AND source_event_id = ?"
    )
    .get(source, sourceEventId);
  return row ? mapEvent(row) : null;
}
