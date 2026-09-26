import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  CORRECTION_ACTION_TYPES,
  CORRECTION_FIELDS,
  type CorrectionActionType,
  type CorrectionInput,
} from "../corrections";
import { AdminActionError } from "./admin-error";
import { CLASSIFIED, dispatchableAction } from "./classifier/dispatch";
import { actionSchema, type Action } from "./classifier/schemas";
import type { ClassificationJobPayload } from "./classifier/worker";
import { CLASSIFICATION_JOB_MAX_ATTEMPTS } from "./config";
import { nowIso } from "./db/json";
import {
  createAttempt,
  getAttempt,
  updateAttempt,
  type ProcessingAttempt,
} from "./db/repositories/attempts";
import {
  createClassification,
  getClassification,
  listClassificationsForEvent,
  type Classification,
} from "./db/repositories/classifications";
import { getEvent } from "./db/repositories/events";
import { enqueueJob, type Job } from "./db/repositories/jobs";
import type { RoutingOutcome, RoutingService } from "./routing/service";

export const CORRECTION_STAGE = "correction";
export const CORRECTION_PROVIDER = "operator";

export const correctionInputSchema = z.object({
  attemptId: z.string().trim().min(1),
  actionType: z.enum(CORRECTION_ACTION_TYPES as [CorrectionActionType, ...CorrectionActionType[]]),
  fields: z.record(z.string(), z.string().nullable()),
}) satisfies z.ZodType<CorrectionInput>;

/** Read a correction request body. Reject a body that does not have the correction shape. */
export function readCorrectionInput(body: unknown): CorrectionInput {
  const parsed = correctionInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new AdminActionError(400, "The body must have attemptId, actionType, and fields.");
  }
  return parsed.data;
}

/** Who made a correction, and which classification it replaces. Stored with the correction. */
export interface CorrectionDetails {
  correctedBy: string;
  correctsClassificationId: string | null;
}

export interface CorrectionResult {
  attempt: ProcessingAttempt;
  classification: Classification;
  /** True when the attempt ID was already submitted, so nothing was dispatched again. */
  duplicate: boolean;
}

/** Build the replacement action from the form fields and validate it with the dispatch schema. */
export function parseCorrection(input: Pick<CorrectionInput, "actionType" | "fields">): Action {
  const specs = CORRECTION_FIELDS[input.actionType];
  if (!specs) throw new AdminActionError(400, `Action type ${input.actionType} cannot be chosen.`);

  const action: Record<string, string | null> = { type: input.actionType };
  const missing: string[] = [];
  for (const spec of specs) {
    const value = input.fields[spec.name]?.trim() || null;
    if (spec.required && value === null) missing.push(spec.label);
    action[spec.name] = value;
  }
  if (missing.length) throw new AdminActionError(400, `Enter a value for: ${missing.join(", ")}.`);

  const parsed = actionSchema.safeParse(action);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`
    );
    throw new AdminActionError(400, `The replacement fields are not valid. ${problems.join("; ")}`);
  }
  return parsed.data;
}

function attemptStatus(outcome: RoutingOutcome): { status: string; error: string | null } {
  if (outcome.status === "unrouted") return { status: "failed", error: outcome.actionResult.error };
  return { status: outcome.status, error: outcome.delivery.lastError };
}

/**
 * Replace the classification of an event with an operator's action and dispatch it. The
 * original classification is kept. The correction is a new classification and a new
 * "correction" processing attempt, and its delivery idempotency key includes the attempt ID.
 * A repeat of the same attempt ID returns the first result and does not dispatch again.
 */
export async function correctClassification(
  db: Database,
  routing: RoutingService,
  eventId: string,
  input: CorrectionInput,
  correctedBy: string
): Promise<CorrectionResult> {
  const event = getEvent(db, eventId);
  if (!event) throw new AdminActionError(404, `Event ${eventId} does not exist.`);

  const existing = getAttempt(db, input.attemptId);
  if (existing) {
    if (existing.eventId !== eventId || existing.stage !== CORRECTION_STAGE) {
      throw new AdminActionError(
        409,
        `Attempt ${input.attemptId} is not a correction of ${eventId}.`
      );
    }
    const { classificationId } = existing.details as { classificationId: string };
    return {
      attempt: existing,
      classification: getClassification(db, classificationId)!,
      duplicate: true,
    };
  }

  const action = parseCorrection(input);
  const correction: CorrectionDetails = {
    correctedBy,
    correctsClassificationId: listClassificationsForEvent(db, eventId).at(-1)?.id ?? null,
  };

  const { attempt, classification } = db.transaction(() => {
    const attempt = createAttempt(db, {
      id: input.attemptId,
      eventId,
      stage: CORRECTION_STAGE,
      status: "running",
      details: correction,
    });
    const classification = createClassification(db, {
      eventId,
      actionType: action.type,
      result: { attemptId: attempt.id, action, correction },
      provider: CORRECTION_PROVIDER,
      model: "manual correction",
      confidence: null,
      status: CLASSIFIED,
      error: null,
    });
    const details = { ...correction, classificationId: classification.id };
    return { attempt: updateAttempt(db, attempt.id, { details })!, classification };
  })();

  const finish = (status: string, error: string | null, extra: object = {}) =>
    updateAttempt(db, attempt.id, {
      status,
      error,
      finishedAt: nowIso(),
      details: { ...(attempt.details as object), ...extra },
    })!;

  let outcome: RoutingOutcome;
  try {
    outcome = await routing.routeAction(event, dispatchableAction(classification)!, {
      attemptId: attempt.id,
    });
  } catch (error) {
    finish("failed", error instanceof Error ? error.message : String(error));
    throw error;
  }

  const { status, error } = attemptStatus(outcome);
  const finished = finish(status, error, {
    deliveryId: outcome.status === "unrouted" ? null : outcome.delivery.id,
    actionResultId: outcome.actionResult?.id ?? null,
  });
  return { attempt: finished, classification, duplicate: false };
}

/**
 * Queue the event for the current classifier again. The worker records a new classification
 * attempt and keeps earlier results. Routing uses the normal idempotency key, so a result with
 * the same action type as an earlier delivery does not send it again.
 */
export function reclassifyEvent(
  db: Database,
  eventId: string,
  requestedBy: string,
  at = nowIso()
): Job<ClassificationJobPayload> {
  if (!getEvent(db, eventId)) throw new AdminActionError(404, `Event ${eventId} does not exist.`);

  const jobs = db
    .query<{ status: string }, [string]>(
      "SELECT status FROM jobs WHERE queue = 'classification' AND event_id = ?"
    )
    .all(eventId);
  if (!jobs.length) {
    throw new AdminActionError(409, `Event ${eventId} is not a capture that Relay classifies.`);
  }
  if (jobs.some((job) => job.status === "pending" || job.status === "running")) {
    throw new AdminActionError(409, `Event ${eventId} is already waiting for classification.`);
  }

  return enqueueJob<ClassificationJobPayload>(db, {
    type: "classify",
    queue: "classification",
    payload: { eventId, reclassification: { requestedBy } },
    eventId,
    maxAttempts: CLASSIFICATION_JOB_MAX_ATTEMPTS,
    availableAt: at,
  });
}
