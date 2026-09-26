import type { Database } from "bun:sqlite";
import { z } from "zod";
import { nowIso } from "../db/json";
import { findEventBySource } from "../db/repositories/events";
import { log as defaultLog } from "../logging";
import type { OperationalMetrics } from "../logging/metrics";
import { operationalMetrics } from "../logging/metrics";
import { createCaptureInTransaction } from "./capture";

export const webCommandInputSchema = z.object({
  text: z.string().trim().min(1),
  submissionId: z.string().trim().min(1),
});

export type WebCommandInput = z.infer<typeof webCommandInputSchema>;

export interface WebCommandResult {
  eventId: string;
  duplicate: boolean;
}

/** Store a web command as a text capture and queue the shared classification job. */
export function ingestWebCommand(
  db: Database,
  input: unknown,
  correlationId: string,
  log: typeof defaultLog = defaultLog,
  metrics: OperationalMetrics = operationalMetrics
): WebCommandResult {
  const parsed = webCommandInputSchema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => issue.message);
    throw new TypeError(`Invalid command submission. ${problems.join("; ")}`);
  }

  const { text, submissionId } = parsed.data;
  const submittedAt = nowIso();
  const result = db.transaction(() => {
    const existing = findEventBySource(db, "web", submissionId);
    if (existing) return { eventId: existing.id, duplicate: true };

    const event = createCaptureInTransaction(db, {
      source: "web",
      sourceEventId: submissionId,
      type: "web.command",
      receivedAt: submittedAt,
      payload: { text },
      text,
      metadata: { submittedAt, recordedAt: submittedAt, correlationId },
    });
    return { eventId: event.id, duplicate: false };
  })();

  if (result.duplicate) {
    log("info", "duplicate event received", {
      stage: "ingest",
      correlationId,
      eventId: result.eventId,
      source: "web",
    });
  } else {
    metrics.recordIncomingEvent();
    log("info", "event ingested", {
      stage: "ingest",
      correlationId,
      eventId: result.eventId,
      source: "web",
      type: "web.command",
    });
  }

  return result;
}
