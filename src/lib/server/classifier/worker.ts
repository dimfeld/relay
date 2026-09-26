import type { Database } from "bun:sqlite";
import { nowIso } from "../db/json";
import { createAttempt, updateAttempt } from "../db/repositories/attempts";
import { createClassification, type Classification } from "../db/repositories/classifications";
import { getEvent, type IncomingEvent } from "../db/repositories/events";
import type { Job } from "../db/repositories/jobs";
import { listRegisteredProjects } from "../projects/registry";
import type { QueueHandler } from "../queue/worker";
import { CLASSIFIED, NEEDS_REVIEW } from "./dispatch";
import { DEFAULT_CONTEXT_LIMIT, DEFAULT_CONTEXT_MAX_AGE_MINUTES } from "../config";
import { selectRecentContext } from "./context";
import type { RateLimitRetryOptions } from "./retry";
import type { Action } from "./schemas";
import { classifyCapture, type ClassificationRecord } from "./service";
import type { ContextItem, JevClassifier, LunaExtractor } from "./types";

export interface ClassificationJobPayload {
  eventId: string;
}

export interface ClassificationHandlerOptions {
  db: Database;
  jev: JevClassifier;
  luna: LunaExtractor;
  wakeName?: string;
  timeZone?: string;
  retry?: RateLimitRetryOptions;
  contextLimit?: number;
  contextMaxAgeMinutes?: number;
  /** Override the default bounded recent-capture selector. */
  selectContext?: (db: Database, event: IncomingEvent) => ContextItem[];
  /** Called only with a validated action, after the classification is stored. */
  onClassified?: (action: Action, classification: Classification) => void | Promise<void>;
}

function referenceTime(event: IncomingEvent): string {
  const recordedAt = event.metadata?.recordedAt;
  return typeof recordedAt === "string" ? recordedAt : event.receivedAt;
}

function extractionMetadata(record: ClassificationRecord) {
  const call = record.luna.at(-1);
  return call ? { provider: call.provider, model: call.model } : null;
}

/**
 * Classify one event. Every run creates a new processing attempt, so job retries and
 * reclassification never overwrite earlier results. The original event is never changed.
 */
export function createClassificationHandler({
  db,
  jev,
  luna,
  wakeName,
  timeZone,
  retry,
  contextLimit = DEFAULT_CONTEXT_LIMIT,
  contextMaxAgeMinutes = DEFAULT_CONTEXT_MAX_AGE_MINUTES,
  selectContext,
  onClassified,
}: ClassificationHandlerOptions): QueueHandler<ClassificationJobPayload> {
  return async (job: Job<ClassificationJobPayload>) => {
    const event = getEvent(db, job.payload.eventId);
    if (!event) throw new Error(`Event ${job.payload.eventId} does not exist.`);

    const attempt = createAttempt(db, {
      eventId: event.id,
      stage: "classification",
      status: "running",
      details: { jobId: job.id, jobAttempt: job.attempts },
    });
    const finishAttempt = (status: string, error: string | null, details: unknown) =>
      updateAttempt(db, attempt.id, { status, error, finishedAt: nowIso(), details });

    let result;
    let selectedContextIds: string[] = [];
    try {
      const context = selectContext
        ? selectContext(db, event)
        : selectRecentContext(db, event, {
            limit: contextLimit,
            maxAgeMinutes: contextMaxAgeMinutes,
          });
      selectedContextIds = context.map((item) => item.eventId);
      result = await classifyCapture(
        {
          text: event.text ?? "",
          referenceTime: referenceTime(event),
          timeZone,
          wakeName,
          projects: listRegisteredProjects(db),
          context,
        },
        { jev, luna, retry }
      );
    } catch (error) {
      finishAttempt("failed", error instanceof Error ? error.message : String(error), {
        jobId: job.id,
        jobAttempt: job.attempts,
        selectedContextIds,
      });
      throw error;
    }

    const details = { jobId: job.id, jobAttempt: job.attempts, ...result.record };

    if (result.status === "failed") {
      // The job retries with a new attempt; after the last job attempt the event needs review.
      const finalAttempt = job.attempts >= job.maxAttempts;
      finishAttempt(finalAttempt ? NEEDS_REVIEW : "failed", result.error, details);
      throw new Error(result.error);
    }

    const classification = db.transaction(() => {
      const created = createClassification(db, {
        eventId: event.id,
        actionType: result.status === "classified" ? result.action.type : result.actionType,
        result:
          result.status === "classified"
            ? {
                attemptId: attempt.id,
                action: result.action,
                extraction: extractionMetadata(result.record),
              }
            : { attemptId: attempt.id, reason: result.record.reason },
        provider: result.record.jev?.provider ?? "typesafe",
        model: result.record.jev?.model ?? "",
        confidence: result.record.jev?.confidence ?? null,
        status: result.status === "classified" ? CLASSIFIED : NEEDS_REVIEW,
        error: result.status === "classified" ? null : result.record.reason,
      });
      finishAttempt(
        result.status === "classified" ? "succeeded" : NEEDS_REVIEW,
        result.status === "classified" ? null : result.record.reason,
        { ...details, classificationId: created.id }
      );
      return created;
    })();

    if (result.status === "classified") await onClassified?.(result.action, classification);
  };
}
