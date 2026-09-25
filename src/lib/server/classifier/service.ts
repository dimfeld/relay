import type { z } from "zod";
import { buildLunaRequest, type ExtractionInput, type RepairInput } from "./extraction";
import { preprocess, type PreprocessedInput, type Signals } from "./preprocess";
import {
  actionTypeForLabel,
  buildJevRequest,
  executorForLabel,
  noteTargetForLabel,
  reminderTimeStated,
} from "./questions";
import { withRateLimitRetry, type RateLimitRetryOptions } from "./retry";
import {
  actionSchema,
  extractionSchemas,
  type Action,
  type ActionType,
  type ExtractableActionType,
  type Extraction,
} from "./schemas";
import {
  ProviderError,
  type CallMetadata,
  type ChoiceAnswer,
  type ContextItem,
  type JevClassifier,
  type LunaExtractor,
  type RegisteredProject,
} from "./types";

export interface ClassifierDependencies {
  jev: JevClassifier;
  luna: LunaExtractor;
  retry?: RateLimitRetryOptions;
}

export interface ClassifyInput {
  text: string;
  /** The capture time, used to resolve relative dates. */
  referenceTime: string;
  timeZone?: string;
  wakeName?: string;
  projects: RegisteredProject[];
  context: ContextItem[];
}

export interface JevCallRecord extends CallMetadata {
  label: string;
  actionType: ActionType | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  answers: Record<string, ChoiceAnswer>;
}

export interface LunaCallRecord extends CallMetadata {
  kind: "extract" | "repair";
  valid: boolean;
  output: unknown;
  issues: string[];
}

/** Operational details for one classification attempt. Contains no credentials or hidden reasoning. */
export interface ClassificationRecord {
  normalizedText: string;
  signals: Signals;
  selectedContextIds: string[];
  jev: JevCallRecord | null;
  luna: LunaCallRecord[];
  reason: string;
}

export type ClassifierResult =
  | { status: "classified"; action: Action; record: ClassificationRecord }
  | { status: "needs_review"; actionType: ActionType; record: ClassificationRecord }
  | { status: "failed"; error: string; record: ClassificationRecord };

type Validation<T> = { ok: true; data: T } | { ok: false; issues: string[] };

type AnyExtraction = Extraction<ExtractableActionType>;

export function validateExtraction(
  actionType: ExtractableActionType,
  output: unknown
): Validation<AnyExtraction> {
  if (output && typeof output === "object" && "type" in output && output.type !== actionType) {
    return {
      ok: false,
      issues: [`type: must be "${actionType}"; Luna returned ${JSON.stringify(output.type)}`],
    };
  }
  const schema: z.ZodType<AnyExtraction> = extractionSchemas[actionType];
  const result = schema.safeParse(output);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    issues: result.error.issues.map(
      (issue) => `${issue.path.join(".") || "output"}: ${issue.message}`
    ),
  };
}

export function resolveProject(
  spoken: string | null,
  projects: RegisteredProject[],
  signals: Signals
): RegisteredProject | null {
  if (spoken) {
    const name = spoken.trim().toLowerCase();
    return (
      projects.find((project) =>
        [project.name, ...project.aliases].some((candidate) => candidate.toLowerCase() === name)
      ) ?? null
    );
  }
  // With no spoken project, accept only one unambiguous exact alias match from preprocessing.
  if (signals.projectHints.length !== 1) return null;
  return projects.find((project) => project.id === signals.projectHints[0].projectId) ?? null;
}

export async function classifyCapture(
  input: ClassifyInput,
  { jev, luna, retry }: ClassifierDependencies
): Promise<ClassifierResult> {
  const preprocessed = preprocess(input.text, input);
  const record: ClassificationRecord = {
    normalizedText: preprocessed.text,
    signals: preprocessed.signals,
    selectedContextIds: input.context.map((item) => item.eventId),
    jev: null,
    luna: [],
    reason: "",
  };
  const failed = (error: unknown): ClassifierResult => {
    if (!(error instanceof ProviderError)) throw error;
    record.reason = `${error.provider} call failed`;
    return { status: "failed", error: error.message, record };
  };
  const needsReview = (actionType: ActionType, reason: string): ClassifierResult => {
    record.reason = reason;
    return { status: "needs_review", actionType, record };
  };

  const { request, noteTargets } = buildJevRequest({
    preprocessed,
    context: input.context,
    referenceTime: input.referenceTime,
    timeZone: input.timeZone,
  });

  let answers: Record<string, ChoiceAnswer>;
  try {
    const response = await withRateLimitRetry(() => jev.classify(request), retry);
    answers = response.answers;
    const selected = answers.action_type;
    record.jev = {
      provider: response.provider,
      model: response.model,
      latencyMs: response.latencyMs,
      usage: response.usage,
      label: selected?.choice ?? "",
      actionType: selected ? actionTypeForLabel(selected.choice) : null,
      confidence: selected?.confidence ?? null,
      probabilities: selected?.probabilities ?? null,
      answers,
    };
  } catch (error) {
    return failed(error);
  }

  const actionType = record.jev.actionType;
  if (!actionType)
    return needsReview("unknown", `Jev returned unexpected label "${record.jev.label}"`);

  if (actionType === "unknown") {
    const action: Action = { type: "unknown", reason: "Jev selected unknown" };
    record.reason = action.reason;
    return { status: "classified", action, record };
  }

  const noteTarget = noteTargetForLabel(answers.note_target?.choice, noteTargets);
  if (actionType === "note.append" && !noteTarget) {
    return needsReview(actionType, "note continuation target is unclear");
  }
  if (actionType === "reminder.create" && !reminderTimeStated(answers.reminder_time?.choice)) {
    return needsReview(actionType, "reminder time is missing");
  }

  const extractionInput: ExtractionInput = {
    actionType,
    preprocessed,
    context: input.context,
    referenceTime: input.referenceTime,
    timeZone: input.timeZone,
  };
  let fields: AnyExtraction;
  try {
    const extracted = await extractWithRepair(extractionInput, luna, record, retry);
    if (!extracted) return needsReview(actionType, "Luna output failed validation after repair");
    fields = extracted;
  } catch (error) {
    return failed(error);
  }

  const built = buildAction(fields, {
    preprocessed,
    projects: input.projects,
    noteTarget,
    executor: executorForLabel(answers.coding_executor?.choice),
  });
  if ("reason" in built) return needsReview(actionType, built.reason);

  const validated = actionSchema.safeParse(built.action);
  if (!validated.success) return needsReview(actionType, "action failed final validation");
  record.reason = `classified as ${actionType}`;
  return { status: "classified", action: validated.data, record };
}

async function extractWithRepair(
  input: ExtractionInput,
  luna: LunaExtractor,
  record: ClassificationRecord,
  retry: RateLimitRetryOptions | undefined
): Promise<AnyExtraction | null> {
  let repair: RepairInput | undefined;
  for (const kind of ["extract", "repair"] as const) {
    const request = buildLunaRequest(input, repair);
    const { output, ...metadata } = await withRateLimitRetry(() => luna.extract(request), retry);
    const validation = validateExtraction(input.actionType, output);
    record.luna.push({
      ...metadata,
      kind,
      valid: validation.ok,
      output,
      issues: validation.ok ? [] : validation.issues,
    });
    if (validation.ok) return validation.data;
    repair = { previousOutput: output, issues: validation.issues };
  }
  return null;
}

function buildAction(
  fields: AnyExtraction,
  options: {
    preprocessed: PreprocessedInput;
    projects: RegisteredProject[];
    noteTarget: ContextItem | null;
    executor: "codex" | "claude" | null;
  }
): { action: unknown } | { reason: string } {
  switch (fields.type) {
    case "reminder.create":
      if (!fields.remindAt) return { reason: "reminder time could not be resolved" };
      return { action: fields };
    case "note.append":
      return {
        action: {
          ...fields,
          targetId: options.noteTarget?.noteId,
          contextEventId: options.noteTarget?.eventId,
        },
      };
    case "command.execute": {
      const project = resolveProject(
        fields.project,
        options.projects,
        options.preprocessed.signals
      );
      if (!project) return { reason: "coding request does not name a registered project" };
      return {
        action: {
          type: "command.execute",
          command: {
            action: "coding.task",
            projectId: project.id,
            projectName: project.name,
            task: fields.task,
            requestedExecutor: options.executor ? { provider: options.executor } : null,
          },
        },
      };
    }
    default:
      return { action: fields };
  }
}
