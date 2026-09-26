import type { Database } from "bun:sqlite";

export const ACTIVITY_STATUSES = [
  "received",
  "processing",
  "pending",
  "succeeded",
  "failed",
  "needs_review",
  "unrouted",
] as const;

export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export interface ActivityFilters {
  source?: string;
  status?: ActivityStatus;
  actionType?: string;
  from?: string;
  to?: string;
}

export interface ActivityRow {
  id: string;
  source: string;
  receivedAt: string;
  summary: string;
  actionType: string;
  confidence: number | null;
  destination: string | null;
  routeId: string | null;
  status: ActivityStatus;
  error: string | null;
  highlight: boolean;
}

interface ActivityDatabaseRow {
  id: string;
  source: string;
  received_at: string;
  payload: string;
  text: string | null;
  action_type: string;
  confidence: number | null;
  destination: string | null;
  route_id: string | null;
  status: ActivityStatus;
  error: string | null;
}

function activityQuery(filters: ActivityFilters): { sql: string; values: string[] } {
  const conditions: string[] = [];
  const values: string[] = [];

  if (filters.source) {
    conditions.push("source = ?");
    values.push(filters.source);
  }
  if (filters.status) {
    conditions.push("status = ?");
    values.push(filters.status);
  }
  if (filters.actionType) {
    conditions.push("action_type = ?");
    values.push(filters.actionType);
  }
  if (filters.from) {
    conditions.push("date(received_at) >= date(?)");
    values.push(filters.from);
  }
  if (filters.to) {
    conditions.push("date(received_at) <= date(?)");
    values.push(filters.to);
  }

  return {
    sql: `
      WITH latest_attempt AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY event_id ORDER BY started_at DESC, id DESC
        ) AS row_number
        FROM processing_attempts
      ),
      latest_classification AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY event_id ORDER BY created_at DESC, id DESC
        ) AS row_number
        FROM classifications
      ),
      latest_delivery AS (
        SELECT d.*, i.name AS destination, ROW_NUMBER() OVER (
          PARTITION BY d.event_id ORDER BY d.updated_at DESC, d.created_at DESC, d.id DESC
        ) AS row_number
        FROM deliveries d
        JOIN integrations i ON i.id = d.integration_id
      ),
      latest_action_result AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY event_id ORDER BY created_at DESC, id DESC
        ) AS row_number
        FROM action_results
      ),
      activity AS (
        SELECT
          e.id,
          e.source,
          e.received_at,
          e.payload,
          e.text,
          COALESCE(c.action_type, e.type) AS action_type,
          c.confidence,
          d.destination,
          d.route_id,
          CASE
            WHEN c.status = 'needs_review' OR a.status = 'needs_review' THEN 'needs_review'
            WHEN d.status IN ('failed', 'dead') THEN 'failed'
            WHEN a.status = 'failed' THEN 'failed'
            WHEN d.status = 'succeeded' THEN 'succeeded'
            WHEN d.status = 'pending' THEN 'pending'
            WHEN ar.status = 'failed' THEN 'failed'
            WHEN ar.status = 'unrouted' THEN 'unrouted'
            WHEN c.status = 'classified' OR a.status IN ('running', 'succeeded') THEN 'processing'
            ELSE 'received'
          END AS status,
          CASE
            WHEN d.status IN ('failed', 'dead') THEN COALESCE(d.last_error, ar.error)
            WHEN c.status = 'needs_review' THEN COALESCE(c.error, a.error)
            WHEN a.status IN ('failed', 'needs_review') THEN a.error
            WHEN d.status IN ('pending', 'succeeded') THEN NULL
            WHEN ar.status IN ('failed', 'unrouted') THEN ar.error
            ELSE NULL
          END AS error
        FROM incoming_events e
        LEFT JOIN latest_attempt a ON a.event_id = e.id AND a.row_number = 1
        LEFT JOIN latest_classification c ON c.event_id = e.id AND c.row_number = 1
        LEFT JOIN latest_delivery d ON d.event_id = e.id AND d.row_number = 1
        LEFT JOIN latest_action_result ar ON ar.event_id = e.id AND ar.row_number = 1
      )
      SELECT * FROM activity
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY received_at DESC, id DESC
    `,
    values,
  };
}

/** Return events with their latest classification and delivery details, newest first. */
export function listActivity(db: Database, filters: ActivityFilters = {}): ActivityRow[] {
  const query = activityQuery(filters);
  const rows = db.query<ActivityDatabaseRow, string[]>(query.sql).all(...query.values);

  return rows.map((row) => {
    let summary = row.text;
    if (summary === null) {
      const payload = JSON.parse(row.payload) as unknown;
      summary = typeof payload === "string" ? payload : JSON.stringify(payload);
    }

    return {
      id: row.id,
      source: row.source,
      receivedAt: row.received_at,
      summary,
      actionType: row.action_type,
      confidence: row.confidence,
      destination: row.destination,
      routeId: row.route_id,
      status: row.status,
      error: row.error,
      highlight:
        row.status === "failed" || row.status === "needs_review" || row.status === "unrouted",
    };
  });
}

export interface ActivityFilterOptions {
  sources: string[];
  actionTypes: string[];
  statuses: readonly ActivityStatus[];
}

export function getActivityFilterOptions(db: Database): ActivityFilterOptions {
  const sources = db
    .query<{ source: string }, []>("SELECT DISTINCT source FROM incoming_events ORDER BY source")
    .all()
    .map((row) => row.source);
  const actionTypes = db
    .query<{ action_type: string }, []>(
      `SELECT action_type FROM classifications
       UNION SELECT type AS action_type FROM incoming_events
       ORDER BY action_type`
    )
    .all()
    .map((row) => row.action_type);

  return { sources, actionTypes, statuses: ACTIVITY_STATUSES };
}
