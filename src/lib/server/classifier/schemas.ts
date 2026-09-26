import { z } from "zod";

export const ACTION_TYPES = [
  "task.create",
  "reminder.create",
  "note.create",
  "note.append",
  "command.execute",
  "tim.plan.create",
  "tim.plan.create_and_execute",
  "unknown",
] as const;

export const TIM_PLAN_REQUEST_EVENT_TYPES = {
  "tim.plan.create.requested": "tim.plan.create",
  "tim.plan.create_and_execute.requested": "tim.plan.create_and_execute",
} as const;

export type ActionType = (typeof ACTION_TYPES)[number];
export type ExtractableActionType = Exclude<ActionType, "unknown">;

const text = z.string().trim().min(1);
const preservedText = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
const extractionText = z.string().min(1);
const dateTime = z.iso.datetime({ offset: true });

/*
 * Luna extraction schemas. Every field is required and nullable so the schema works with
 * OpenAI structured outputs. Strict objects reject extra fields, so a model cannot add an
 * executable, working directory, or command flag to a coding request.
 */
export const extractionSchemas = {
  "task.create": z.strictObject({
    type: z.literal("task.create"),
    title: text,
    notes: text.nullable(),
    dueAt: dateTime.nullable(),
  }),
  "reminder.create": z.strictObject({
    type: z.literal("reminder.create"),
    text,
    remindAt: dateTime.nullable(),
    timeZone: text.nullable(),
    originalTimePhrase: text.nullable(),
  }),
  "note.create": z.strictObject({
    type: z.literal("note.create"),
    title: text.nullable(),
    body: text,
    topic: text.nullable(),
  }),
  "note.append": z.strictObject({
    type: z.literal("note.append"),
    body: text,
  }),
  "command.execute": z.strictObject({
    type: z.literal("command.execute"),
    project: text.nullable(),
    task: text,
  }),
  "tim.plan.create": z.strictObject({
    type: z.literal("tim.plan.create"),
    project: text.nullable(),
    description: extractionText,
  }),
  "tim.plan.create_and_execute": z.strictObject({
    type: z.literal("tim.plan.create_and_execute"),
    project: text.nullable(),
    description: extractionText,
  }),
} satisfies Record<ExtractableActionType, z.ZodType>;

export type Extraction<T extends ExtractableActionType> = z.infer<(typeof extractionSchemas)[T]>;

export const taskCreateAction = extractionSchemas["task.create"];

export const reminderCreateAction = extractionSchemas["reminder.create"].extend({
  remindAt: dateTime,
});

export const noteCreateAction = extractionSchemas["note.create"];

export const noteAppendAction = extractionSchemas["note.append"].extend({
  targetId: text,
  contextEventId: text,
});

export const executorProvider = z.enum(["codex", "claude"]);

export const commandExecuteAction = z.strictObject({
  type: z.literal("command.execute"),
  command: z.strictObject({
    action: z.literal("coding.task"),
    projectId: text,
    projectName: text,
    task: text,
    requestedExecutor: z.strictObject({ provider: executorProvider }).nullable(),
  }),
});

export const timPlanCreateAction = z.strictObject({
  type: z.literal("tim.plan.create"),
  projectId: text,
  projectName: text,
  description: preservedText,
});

export const timPlanCreateAndExecuteAction = z.strictObject({
  type: z.literal("tim.plan.create_and_execute"),
  projectId: text,
  projectName: text,
  description: preservedText,
});

export const unknownAction = z.strictObject({
  type: z.literal("unknown"),
  reason: text,
});

/** A validated action: the fixed Jev type plus fields that passed that type's schema. */
export const actionSchema = z.discriminatedUnion("type", [
  taskCreateAction,
  reminderCreateAction,
  noteCreateAction,
  noteAppendAction,
  commandExecuteAction,
  timPlanCreateAction,
  timPlanCreateAndExecuteAction,
  unknownAction,
]);

export type Action = z.infer<typeof actionSchema>;
