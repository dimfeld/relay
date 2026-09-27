import type { Database } from "bun:sqlite";
import type { Category } from "../classifier/types";
import { resolveRoute } from "../routing/resolve";
import { fetchMailCategories } from "./mail";
import { fetchTransport } from "./http";
import type { HttpTransport } from "./types";

/** The action types that can carry a category. */
export const CATEGORIZED_ACTION_TYPES = ["task.create", "reminder.create", "note.create"] as const;

export type CategorySource = (correlationId: string) => Promise<Category[]>;

/**
 * Read categories from the Mail integration that owns tasks, reminders, and notes. A category
 * ID only has meaning to the owner that issued it, so when these actions do not all route to
 * one Mail integration, there are no categories to offer.
 */
export function createMailCategorySource(
  db: Database,
  transport: HttpTransport = fetchTransport
): CategorySource {
  return async (correlationId) => {
    const owners = new Map(
      CATEGORIZED_ACTION_TYPES.map((actionType) => resolveRoute(db, { actionType }))
        .filter((resolved) => resolved !== null)
        .map(({ integration }) => [integration.id, integration])
    );
    const [owner] = owners.values();
    if (owners.size !== 1 || owner?.kind !== "mail") return [];
    return fetchMailCategories(owner, correlationId, transport);
  };
}
