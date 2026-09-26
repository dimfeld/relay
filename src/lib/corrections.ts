/** An editable structured field of a replacement action. The action schema validates it. */
export interface CorrectionField {
  name: string;
  label: string;
  required: boolean;
}

/**
 * Action types an operator can choose as a correction, with their editable fields.
 * `command.execute` and `unknown` are not listed: a correction must not start agent coding,
 * and an unknown action has nothing to dispatch.
 */
export const CORRECTION_FIELDS = {
  "task.create": [
    { name: "title", label: "Title", required: true },
    { name: "notes", label: "Notes", required: false },
    { name: "dueAt", label: "Due at (ISO 8601)", required: false },
  ],
  "reminder.create": [
    { name: "text", label: "Text", required: true },
    { name: "remindAt", label: "Remind at (ISO 8601)", required: true },
    { name: "timeZone", label: "Time zone", required: false },
    { name: "originalTimePhrase", label: "Original time phrase", required: false },
  ],
  "note.create": [
    { name: "title", label: "Title", required: false },
    { name: "body", label: "Body", required: true },
    { name: "topic", label: "Topic", required: false },
  ],
  "note.append": [
    { name: "body", label: "Body", required: true },
    { name: "targetId", label: "Target note ID", required: true },
    { name: "contextEventId", label: "Context event ID", required: true },
  ],
  "tim.plan.create": [
    { name: "project", label: "Project name or alias", required: true },
    { name: "description", label: "Plan description", required: true },
  ],
  "tim.plan.create_and_execute": [
    { name: "project", label: "Project name or alias", required: true },
    { name: "description", label: "Plan description", required: true },
  ],
} as const satisfies Record<string, readonly CorrectionField[]>;

export type CorrectionActionType = keyof typeof CORRECTION_FIELDS;

export const CORRECTION_ACTION_TYPES = Object.keys(CORRECTION_FIELDS) as CorrectionActionType[];

export interface CorrectionInput {
  /** A new ID for each correction the operator submits. A repeat of the same ID does nothing. */
  attemptId: string;
  actionType: CorrectionActionType;
  /** Field values from the form. An empty value is stored as null. */
  fields: Record<string, string | null>;
}
