import type { PreprocessedInput } from "./preprocess";
import type { ActionType } from "./schemas";
import type { ChoiceQuestion, ContextItem, ExecutorProvider, JevRequest } from "./types";

/*
 * Every choice the pipeline needs is asked to Jev in one request. Answers that do not apply
 * to the selected action type are ignored.
 */

const ACTION_OPTIONS = {
  task: "A to-do item the speaker wants to track and complete.",
  reminder: "A request to be reminded about something at a specific time.",
  new_note: "Information, an idea, or an observation to save as a new note.",
  note_continuation: "More content for a note from the recent context, such as 'also...'.",
  coding_request: "An instruction for a coding agent to change a software project.",
  unknown: "None of the above, unclear, or not addressed to the assistant.",
} as const;

const ACTION_TYPE_BY_LABEL: Record<keyof typeof ACTION_OPTIONS, ActionType> = {
  task: "task.create",
  reminder: "reminder.create",
  new_note: "note.create",
  note_continuation: "note.append",
  coding_request: "command.execute",
  unknown: "unknown",
};

const EXECUTOR_OPTIONS = {
  codex: "The speaker asks for Codex.",
  claude: "The speaker asks for Claude or Claude Code.",
  unspecified: "The speaker does not ask for a specific coding agent.",
} as const;

const REMINDER_TIME_OPTIONS = {
  stated: "The capture states when the reminder should happen, as a date, time, or relative time.",
  missing: "The capture does not say when the reminder should happen.",
} as const;

const NO_NOTE_TARGET = "none";

export interface QuestionInput {
  preprocessed: PreprocessedInput;
  context: ContextItem[];
  referenceTime: string;
  timeZone?: string;
}

export interface BuiltQuestions {
  request: JevRequest;
  /** Note target labels mapped to the context item they identify. */
  noteTargets: Map<string, ContextItem>;
}

export function buildJevRequest({
  preprocessed,
  context,
  referenceTime,
  timeZone,
}: QuestionInput): BuiltQuestions {
  const noteTargets = new Map<string, ContextItem>();
  context.forEach((item, index) => {
    if (item.noteId) noteTargets.set(`context_${index + 1}`, item);
  });

  const questions: Record<string, ChoiceQuestion> = {
    action_type: {
      instructions: "Which kind of action does the speaker want from this voice capture?",
      options: ACTION_OPTIONS,
    },
    coding_executor: {
      instructions: "If this is a coding request, which coding agent does the speaker ask for?",
      options: EXECUTOR_OPTIONS,
    },
    reminder_time: {
      instructions: "If this is a reminder, does the capture say when to remind the speaker?",
      options: REMINDER_TIME_OPTIONS,
    },
  };
  if (noteTargets.size) {
    questions.note_target = {
      instructions: "If this continues an earlier note, which recent capture does it continue?",
      options: {
        ...Object.fromEntries([...noteTargets].map(([label, item]) => [label, item.text])),
        [NO_NOTE_TARGET]: "It does not clearly continue any of these captures.",
      },
    };
  }

  const state = {
    capture: preprocessed.text,
    referenceTime,
    ...(timeZone ? { timeZone } : {}),
    signals: preprocessed.signals,
    recentContext: context.map((item, index) => ({
      label: `context_${index + 1}`,
      text: item.text,
      actionType: item.actionType,
    })),
  };

  return { request: { state, questions }, noteTargets };
}

export function actionTypeForLabel(label: string): ActionType | null {
  return ACTION_TYPE_BY_LABEL[label as keyof typeof ACTION_TYPE_BY_LABEL] ?? null;
}

export function executorForLabel(label: string | undefined): ExecutorProvider | null {
  return label === "codex" || label === "claude" ? label : null;
}

export function reminderTimeStated(label: string | undefined): boolean {
  return label === "stated";
}

export function noteTargetForLabel(
  label: string | undefined,
  noteTargets: Map<string, ContextItem>
): ContextItem | null {
  return label ? (noteTargets.get(label) ?? null) : null;
}
