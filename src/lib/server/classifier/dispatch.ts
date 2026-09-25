import type { Classification } from "../db/repositories/classifications";
import { actionSchema, type Action } from "./schemas";

export const CLASSIFIED = "classified";
export const NEEDS_REVIEW = "needs_review";

/**
 * Return the action only when the classification is valid. Routing must read actions through
 * this function so an invalid or needs_review result cannot start a side effect.
 */
export function dispatchableAction(classification: Classification): Action | null {
  if (classification.status !== CLASSIFIED) return null;
  const result = classification.result as { action?: unknown } | null;
  const parsed = actionSchema.safeParse(result?.action);
  return parsed.success && parsed.data.type === classification.actionType ? parsed.data : null;
}
