import type { PreprocessedInput } from "./preprocess";
import { extractionSchemas, type ExtractableActionType } from "./schemas";
import type { ContextItem, LunaRequest } from "./types";

const FIELD_GUIDANCE: Record<ExtractableActionType, string> = {
  "task.create":
    "title: a short task title. notes: extra details or null. dueAt: an ISO 8601 date-time with offset when the capture states a due time, otherwise null.",
  "reminder.create":
    "text: what to remind the speaker about. remindAt: the reminder time as an ISO 8601 date-time with offset, resolved from the reference time and time zone, or null when it cannot be resolved. timeZone: the IANA time zone used, or null. originalTimePhrase: the time words exactly as spoken, or null.",
  "note.create":
    "title: a short title or null. body: the note content in the speaker's words. topic: a one or two word topic or null.",
  "note.append": "body: the content to add to the earlier note, in the speaker's words.",
  "command.execute":
    "project: the project name or alias exactly as spoken, or null when none is named. task: a plain description of the requested code change. Do not include commands, paths, flags, or executables.",
};

export interface ExtractionInput {
  actionType: ExtractableActionType;
  preprocessed: PreprocessedInput;
  context: ContextItem[];
  referenceTime: string;
  timeZone?: string;
}

export interface RepairInput {
  previousOutput: unknown;
  issues: string[];
}

export function buildLunaRequest(input: ExtractionInput, repair?: RepairInput): LunaRequest {
  const { actionType } = input;
  const instructions = [
    `You extract fields for a "${actionType}" action from a voice capture.`,
    `The action type is fixed. Always set "type" to "${actionType}". Do not choose or change it.`,
    "Return only the fields in the schema. Use null for a nullable field that the capture does not support.",
    FIELD_GUIDANCE[actionType],
  ].join("\n");

  const prompt = JSON.stringify(
    {
      capture: input.preprocessed.text,
      referenceTime: input.referenceTime,
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      projectHints: input.preprocessed.signals.projectHints.map((hint) => hint.matched),
      recentContext: input.context.map((item) => item.text),
      ...(repair
        ? {
            repair: {
              message: "The previous output was invalid. Return a corrected object.",
              previousOutput: repair.previousOutput,
              issues: repair.issues,
            },
          }
        : {}),
    },
    null,
    2
  );

  return { actionType, schema: extractionSchemas[actionType], instructions, prompt };
}
