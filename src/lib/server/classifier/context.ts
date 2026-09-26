import type { Database } from "bun:sqlite";
import { DEFAULT_CONTEXT_LIMIT, DEFAULT_CONTEXT_MAX_AGE_MINUTES } from "../config";
import { parseNullableJson } from "../db/json";
import type { IncomingEvent } from "../db/repositories/events";
import type { ContextItem } from "./types";

export interface ContextSelectionOptions {
  limit?: number;
  maxAgeMinutes?: number;
}

interface ContextRow {
  event_id: string;
  text: string;
  action_type: string | null;
  action_result: string | null;
}

/** Select prior captures by the current event time, newest first, within fixed bounds. */
export function selectRecentContext(
  db: Database,
  event: IncomingEvent,
  {
    limit = DEFAULT_CONTEXT_LIMIT,
    maxAgeMinutes = DEFAULT_CONTEXT_MAX_AGE_MINUTES,
  }: ContextSelectionOptions = {}
): ContextItem[] {
  const receivedAt = Date.parse(event.receivedAt);
  if (!Number.isFinite(receivedAt)) return [];

  const oldestReceivedAt = new Date(receivedAt - maxAgeMinutes * 60_000).toISOString();
  const rows = db
    .query<ContextRow, [string, string, string, number]>(
      `SELECT e.id AS event_id, e.text,
         (SELECT c.action_type
          FROM classifications c
          WHERE c.event_id = e.id AND c.status = 'classified'
          ORDER BY c.created_at DESC LIMIT 1) AS action_type,
         (SELECT ar.result
          FROM action_results ar
          WHERE ar.event_id = e.id
            AND ar.action_type IN ('note.create', 'note.append')
            AND ar.result IS NOT NULL
          ORDER BY ar.created_at DESC LIMIT 1) AS action_result
       FROM incoming_events e
       WHERE e.id <> ?
         AND e.text IS NOT NULL
         AND julianday(e.received_at) < julianday(?)
         AND julianday(e.received_at) >= julianday(?)
       ORDER BY julianday(e.received_at) DESC, e.rowid DESC
       LIMIT ?`
    )
    .all(event.id, event.receivedAt, oldestReceivedAt, limit);

  return rows.map((row) => ({
    eventId: row.event_id,
    text: row.text,
    actionType: row.action_type,
    noteId: noteIdFromResult(row.action_result),
  }));
}

function noteIdFromResult(result: string | null): string | null {
  if (!result) return null;
  const parsed = parseNullableJson<unknown>(result);
  if (!parsed || typeof parsed !== "object") return null;

  const noteResult = parsed as { id?: unknown; noteId?: unknown };
  const noteId = noteResult.noteId ?? noteResult.id;
  return typeof noteId === "string" && noteId.length > 0 ? noteId : null;
}
