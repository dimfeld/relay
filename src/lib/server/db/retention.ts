import type { Database } from "bun:sqlite";
import { log as defaultLog } from "../logging";

export interface RetentionCounts {
  jobs: number;
  actionResults: number;
  deliveries: number;
  classifications: number;
  attempts: number;
  executionLogs: number;
  executions: number;
  events: number;
}

type RetentionLogger = typeof defaultLog;

/** Remove pipeline history older than cutoffIso, including raw event payloads. */
export function pruneExpiredHistory(db: Database, cutoffIso: string): RetentionCounts {
  return db.transaction(() => {
    const oldEvents = "SELECT id FROM incoming_events WHERE received_at < ?";
    const oldTerminalExecutions =
      "SELECT id FROM executions WHERE updated_at < ? AND status IN ('succeeded', 'failed', 'cancelled')";
    const counts: RetentionCounts = {
      jobs: db
        .query(
          `DELETE FROM jobs
           WHERE event_id IN (${oldEvents}) OR
             (updated_at < ? AND status IN ('succeeded', 'failed', 'dead'))`
        )
        .run(cutoffIso, cutoffIso).changes,
      actionResults: db
        .query(`DELETE FROM action_results WHERE event_id IN (${oldEvents})`)
        .run(cutoffIso).changes,
      deliveries: db.query(`DELETE FROM deliveries WHERE event_id IN (${oldEvents})`).run(cutoffIso)
        .changes,
      classifications: db
        .query(`DELETE FROM classifications WHERE event_id IN (${oldEvents})`)
        .run(cutoffIso).changes,
      attempts: db
        .query(`DELETE FROM processing_attempts WHERE event_id IN (${oldEvents})`)
        .run(cutoffIso).changes,
      executionLogs: db
        .query(
          `DELETE FROM execution_logs
           WHERE ts < ? OR execution_id IN (
             SELECT id FROM executions
             WHERE event_id IN (${oldEvents}) OR id IN (${oldTerminalExecutions})
           )`
        )
        .run(cutoffIso, cutoffIso, cutoffIso).changes,
      executions: db
        .query(
          `DELETE FROM executions
           WHERE event_id IN (${oldEvents}) OR id IN (${oldTerminalExecutions})`
        )
        .run(cutoffIso, cutoffIso).changes,
      events: db.query(`DELETE FROM incoming_events WHERE received_at < ?`).run(cutoffIso).changes,
    };
    return counts;
  })();
}

export interface RetentionWorkerOptions {
  retentionDays: number;
  intervalMs: number;
  log?: RetentionLogger;
  now?: () => Date;
}

/** Run pruning at startup and then at the configured interval. */
export function startRetentionPruner(
  db: Database,
  { retentionDays, intervalMs, log = defaultLog, now = () => new Date() }: RetentionWorkerOptions
): () => void {
  function prune(): void {
    try {
      const cutoff = new Date(now().getTime() - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
      const counts = pruneExpiredHistory(db, cutoff);
      if (Object.values(counts).some((count) => count > 0)) {
        log("info", "application history pruned", { cutoff, ...counts });
      }
    } catch (error) {
      log("error", "application history pruning failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  prune();
  const timer = setInterval(prune, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
