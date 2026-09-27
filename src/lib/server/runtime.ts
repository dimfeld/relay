import type { Database } from "bun:sqlite";
import { createProviderAdapters } from "./classifier/adapters";
import type { JevClassifier, LunaExtractor } from "./classifier/types";
import { createClassificationHandler } from "./classifier/worker";
import { loadClassifierConfig, type AppConfig, type ClassifierConfig } from "./config";
import { createMailCategorySource } from "./integrations/categories";
import type { HttpTransport } from "./integrations/types";
import { startWorkers } from "./queue/workers";
import {
  createDeliveryQueueHandler,
  createOnClassifiedCallback,
  type RoutingService,
} from "./routing/service";

export interface BackgroundWorkerOptions {
  db: Database;
  config: AppConfig;
  routing: RoutingService;
  /** Defaults to the provider settings in the environment. */
  classifierConfig?: ClassifierConfig;
  /** Override the providers built from classifierConfig. */
  providers?: { jev: JevClassifier; luna: LunaExtractor };
  categoryTransport?: HttpTransport;
}

/**
 * Start the classification and delivery queue workers. No producer queues execution jobs yet,
 * so there is no execution worker.
 */
export function startBackgroundWorkers({
  db,
  config,
  routing,
  classifierConfig = loadClassifierConfig(),
  providers = createProviderAdapters(classifierConfig),
  categoryTransport,
}: BackgroundWorkerOptions) {
  return startWorkers(
    db,
    {
      classification: createClassificationHandler({
        db,
        ...providers,
        wakeName: config.WAKE_NAME,
        timeZone: classifierConfig.TIME_ZONE,
        contextLimit: classifierConfig.CLASSIFIER_CONTEXT_LIMIT,
        contextMaxAgeMinutes: classifierConfig.CLASSIFIER_CONTEXT_MAX_AGE_MINUTES,
        loadCategories: createMailCategorySource(db, categoryTransport),
        onClassified: createOnClassifiedCallback(db, routing),
      }),
      delivery: createDeliveryQueueHandler(db, routing),
    },
    {
      pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
      staleAfterMs: config.WORKER_STALE_AFTER_MS,
    }
  );
}
