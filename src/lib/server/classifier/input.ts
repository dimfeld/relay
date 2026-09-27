import type { Database } from "bun:sqlite";
import { DEFAULT_CONTEXT_LIMIT, DEFAULT_CONTEXT_MAX_AGE_MINUTES } from "../config";
import type { IncomingEvent } from "../db/repositories/events";
import type { CategorySource } from "../integrations/categories";
import { listRegisteredProjects } from "../projects/registry";
import { selectRecentContext } from "./context";
import type { ClassifyInput } from "./service";
import type { ContextItem } from "./types";

export interface ClassificationInputOptions {
  db: Database;
  event: IncomingEvent;
  correlationId: string;
  wakeName?: string;
  timeZone?: string;
  contextLimit?: number;
  contextMaxAgeMinutes?: number;
  selectContext?: (db: Database, event: IncomingEvent) => ContextItem[];
  loadCategories?: CategorySource;
  onCategoryError?: (error: unknown) => void;
}

/** Build the same classifier input for a stored capture or an in-memory preview. */
export async function buildClassificationInput({
  db,
  event,
  correlationId,
  wakeName,
  timeZone,
  contextLimit = DEFAULT_CONTEXT_LIMIT,
  contextMaxAgeMinutes = DEFAULT_CONTEXT_MAX_AGE_MINUTES,
  selectContext,
  loadCategories,
  onCategoryError,
}: ClassificationInputOptions): Promise<ClassifyInput> {
  const context = selectContext
    ? selectContext(db, event)
    : selectRecentContext(db, event, {
        limit: contextLimit,
        maxAgeMinutes: contextMaxAgeMinutes,
      });
  let categories: ClassifyInput["categories"] = [];
  try {
    categories = (await loadCategories?.(correlationId)) ?? [];
  } catch (error) {
    onCategoryError?.(error);
  }
  const recordedAt = event.metadata?.recordedAt;
  return {
    text: event.text ?? "",
    referenceTime: typeof recordedAt === "string" ? recordedAt : event.receivedAt,
    timeZone,
    wakeName,
    projects: listRegisteredProjects(db),
    context,
    categories,
  };
}
