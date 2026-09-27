import type { Database } from "bun:sqlite";
import { createProviderAdapters } from "../classifier/adapters";
import { buildClassificationInput } from "../classifier/input";
import { classifyCapture, type ClassifierDependencies } from "../classifier/service";
import type { Category } from "../classifier/types";
import { loadClassifierConfig, type AppConfig, type ClassifierConfig } from "../config";
import type { IncomingEvent } from "../db/repositories/events";
import { createMailCategorySource } from "../integrations/categories";
import { resolveRoute } from "../routing/resolve";
import { webCommandInputSchema } from "./web";

export interface PreviewOptions {
  db: Database;
  config: Pick<AppConfig, "WAKE_NAME">;
  classifierConfig?: ClassifierConfig;
  providers?: ClassifierDependencies;
  loadCategories?: (correlationId: string) => Promise<Category[]>;
  now?: () => string;
}

/** Classify a web command and inspect its route without storing or dispatching it. */
export async function previewWebCommand(
  input: unknown,
  correlationId: string,
  options: PreviewOptions
) {
  const { text } = webCommandInputSchema.pick({ text: true }).parse(input);
  const classifierConfig = options.classifierConfig ?? loadClassifierConfig();
  const providers = options.providers ?? createProviderAdapters(classifierConfig);
  const receivedAt = options.now?.() ?? new Date().toISOString();
  const event: IncomingEvent = {
    id: crypto.randomUUID(),
    source: "web",
    sourceEventId: null,
    type: "web.command",
    receivedAt,
    payload: { text },
    text,
    metadata: { recordedAt: receivedAt, correlationId },
  };
  const classificationInput = await buildClassificationInput({
    db: options.db,
    event,
    correlationId,
    timeZone: classifierConfig.TIME_ZONE,
    wakeName: options.config.WAKE_NAME,
    contextLimit: classifierConfig.CLASSIFIER_CONTEXT_LIMIT,
    contextMaxAgeMinutes: classifierConfig.CLASSIFIER_CONTEXT_MAX_AGE_MINUTES,
    loadCategories: options.loadCategories ?? createMailCategorySource(options.db),
  });
  const result = await classifyCapture(classificationInput, providers);
  const route =
    result.status === "classified"
      ? resolveRoute(options.db, { eventType: event.type, actionType: result.action.type })
      : null;
  return {
    ...result,
    route: route
      ? {
          id: route.route.id,
          integrationId: route.integration.id,
          integrationName: route.integration.name,
        }
      : null,
  };
}

export type WebCommandPreview = Awaited<ReturnType<typeof previewWebCommand>>;
