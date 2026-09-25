import type { Database } from "bun:sqlite";
import type { Backoff } from "./backoff";
import { exponentialBackoff } from "./backoff";
import { createWorker, type QueueHandler } from "./worker";

export interface WorkerSettings {
  pollIntervalMs: number;
  staleAfterMs: number;
  backoff?: Backoff;
  now?: () => Date;
}

function makeWorker<TPayload>(
  db: Database,
  queue: string,
  handler: QueueHandler<TPayload>,
  settings: WorkerSettings
) {
  return createWorker({
    db,
    queue,
    handler,
    ...settings,
    backoff: settings.backoff ?? exponentialBackoff,
  });
}

export function createClassificationWorker<TPayload = unknown>(
  db: Database,
  handler: QueueHandler<TPayload>,
  settings: WorkerSettings
) {
  return makeWorker(db, "classification", handler, settings);
}

export function createDeliveryWorker<TPayload = unknown>(
  db: Database,
  handler: QueueHandler<TPayload>,
  settings: WorkerSettings
) {
  return makeWorker(db, "delivery", handler, settings);
}

export function createExecutionWorker<TPayload = unknown>(
  db: Database,
  handler: QueueHandler<TPayload>,
  settings: WorkerSettings
) {
  return makeWorker(db, "execution", handler, settings);
}

export function startWorkers<TPayload = unknown>(
  db: Database,
  handlers: {
    classification: QueueHandler<TPayload>;
    delivery: QueueHandler<TPayload>;
    execution: QueueHandler<TPayload>;
  },
  settings: WorkerSettings
) {
  const workers = {
    classification: createClassificationWorker(db, handlers.classification, settings),
    delivery: createDeliveryWorker(db, handlers.delivery, settings),
    execution: createExecutionWorker(db, handlers.execution, settings),
  };
  for (const worker of Object.values(workers)) worker.start();

  return {
    workers,
    async stop() {
      await Promise.all(Object.values(workers).map((worker) => worker.stop()));
    },
  };
}
