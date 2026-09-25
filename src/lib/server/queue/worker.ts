import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  claimJob,
  completeJob,
  failJob,
  recoverStaleJobs,
  type Job,
} from "../db/repositories/jobs";
import { log } from "../logging";
import { exponentialBackoff, type Backoff } from "./backoff";

export interface QueueWorkerOptions<TPayload = unknown> {
  db: Database;
  queue: string;
  handler: (job: Job<TPayload>) => void | Promise<void>;
  workerId?: string;
  pollIntervalMs: number;
  staleAfterMs: number;
  backoff?: Backoff;
  now?: () => Date;
}

export function createWorker<TPayload = unknown>({
  db,
  queue,
  handler,
  workerId = `${hostname()}:${process.pid}:${queue}:${randomUUID()}`,
  pollIntervalMs,
  staleAfterMs,
  backoff = exponentialBackoff,
  now = () => new Date(),
}: QueueWorkerOptions<TPayload>) {
  let running = false;
  let loopPromise: Promise<void> | undefined;
  let wakePoll: (() => void) | undefined;

  async function runOnce(): Promise<boolean> {
    const currentTime = now();
    const at = currentTime.toISOString();
    const staleBefore = new Date(currentTime.getTime() - staleAfterMs).toISOString();
    recoverStaleJobs(db, staleBefore, at, queue);

    const job = claimJob<TPayload>(db, workerId, at, queue);
    if (!job) return false;

    try {
      await handler(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("error", "queue job handler failed", { queue, jobId: job.id, workerId, error: message });
      const availableAt = new Date(now().getTime() + backoff(job.attempts)).toISOString();
      failJob(db, job.id, workerId, message, availableAt, true, now().toISOString());
      return true;
    }

    completeJob(db, job.id, workerId, now().toISOString());
    return true;
  }

  function waitForPoll(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakePoll = undefined;
        resolve();
      }, pollIntervalMs);
      wakePoll = () => {
        clearTimeout(timer);
        wakePoll = undefined;
        resolve();
      };
    });
  }

  function start(): void {
    if (loopPromise) return;
    running = true;
    loopPromise = (async () => {
      while (running) {
        try {
          await runOnce();
        } catch (error) {
          log("error", "queue worker failed", {
            queue,
            workerId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (running) await waitForPoll();
      }
    })().finally(() => {
      loopPromise = undefined;
    });
  }

  async function stop(): Promise<void> {
    running = false;
    wakePoll?.();
    await loopPromise;
  }

  return { workerId, runOnce, start, stop };
}

export type QueueHandler<TPayload = unknown> = (job: Job<TPayload>) => void | Promise<void>;
