import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/lib/server/db";
import {
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  getJob,
  listJobs,
  recoverStaleJobs,
} from "../src/lib/server/db/repositories/jobs";
import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  exponentialBackoff,
} from "../src/lib/server/queue/backoff";
import { createWorker } from "../src/lib/server/queue/worker";
import { startWorkers } from "../src/lib/server/queue/workers";

let databases: Database[] = [];
let directories: string[] = [];

afterEach(() => {
  for (const db of databases) db.close();
  databases = [];
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories = [];
});

function createDatabase(): Database {
  const db = openDatabase(":memory:");
  databases.push(db);
  return db;
}

function workerSettings(now: () => Date) {
  return {
    pollIntervalMs: 1_000,
    staleAfterMs: 10_000,
    backoff: (attempt: number) => 1_000 * 2 ** (attempt - 1),
    now,
  };
}

describe("queue workers", () => {
  test("separate SQLite connections do not run the same job concurrently", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-queue-"));
    directories.push(directory);
    const path = join(directory, "relay.sqlite");
    const firstDb = openDatabase(path);
    const secondDb = openDatabase(path);
    databases.push(firstDb, secondDb);
    enqueueJob(firstDb, {
      type: "work",
      queue: "classification",
      payload: {},
      maxAttempts: 2,
      availableAt: "2026-01-01T00:00:00.000Z",
    });

    let handlerCalls = 0;
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const now = () => new Date("2026-01-01T00:01:00.000Z");
    const firstWorker = createWorker({
      db: firstDb,
      queue: "classification",
      workerId: "worker-1",
      handler: async () => {
        handlerCalls += 1;
        await handlerGate;
      },
      ...workerSettings(now),
    });
    const secondWorker = createWorker({
      db: secondDb,
      queue: "classification",
      workerId: "worker-2",
      handler: () => {
        handlerCalls += 1;
      },
      ...workerSettings(now),
    });

    const firstRun = firstWorker.runOnce();
    const secondClaimed = await secondWorker.runOnce();
    releaseHandler();
    const firstClaimed = await firstRun;

    expect(firstClaimed).toBe(true);
    expect(secondClaimed).toBe(false);
    expect(handlerCalls).toBe(1);
  });

  test("retries failed jobs after backoff and keeps exhausted jobs inspectable", async () => {
    const db = createDatabase();
    let currentTime = new Date("2026-01-01T00:00:00.000Z");
    let handlerCalls = 0;
    const worker = createWorker({
      db,
      queue: "delivery",
      workerId: "delivery-worker",
      handler: () => {
        handlerCalls += 1;
        throw new Error("temporary failure");
      },
      ...workerSettings(() => currentTime),
    });
    const job = enqueueJob(db, {
      type: "deliver",
      queue: "delivery",
      payload: { eventId: "event-1" },
      maxAttempts: 2,
      availableAt: currentTime.toISOString(),
    });

    expect(await worker.runOnce()).toBe(true);
    expect(getJob(db, job.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      availableAt: "2026-01-01T00:00:01.000Z",
      lastError: "temporary failure",
    });
    expect(await worker.runOnce()).toBe(false);

    currentTime = new Date("2026-01-01T00:00:00.999Z");
    expect(await worker.runOnce()).toBe(false);
    currentTime = new Date("2026-01-01T00:00:01.000Z");
    expect(await worker.runOnce()).toBe(true);
    expect(handlerCalls).toBe(2);
    expect(listJobs(db, { status: "dead", queue: "delivery" })).toMatchObject([
      { id: job.id, attempts: 2, lastError: "temporary failure" },
    ]);
  });

  test("recovers stale claims and rejects the old owner's completion or failure", async () => {
    const db = createDatabase();
    const oldClaimTime = "2026-01-01T00:00:00.000Z";
    const job = enqueueJob(db, {
      type: "execute",
      queue: "execution",
      payload: {},
      maxAttempts: 3,
      availableAt: oldClaimTime,
    });
    expect(claimJob(db, "old-worker", oldClaimTime, "execution")?.id).toBe(job.id);

    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const worker = createWorker({
      db,
      queue: "execution",
      workerId: "new-worker",
      handler: async () => await handlerGate,
      ...workerSettings(() => new Date("2026-01-01T00:00:11.000Z")),
    });

    const run = worker.runOnce();
    expect(getJob(db, job.id)).toMatchObject({
      status: "running",
      attempts: 2,
      lockedBy: "new-worker",
    });
    expect(claimJob(db, "third-worker", "2026-01-01T00:00:11.000Z", "execution")).toBeNull();
    expect(completeJob(db, job.id, "old-worker", "2026-01-01T00:00:12.000Z")).toBeNull();
    expect(
      failJob(db, job.id, "old-worker", "late failure", "2026-01-01T00:00:12.000Z")
    ).toBeNull();

    releaseHandler();
    expect(await run).toBe(true);
    expect(getJob(db, job.id)).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  test("marks an exhausted stale claim dead with an inspectable error", () => {
    const db = createDatabase();
    const job = enqueueJob(db, {
      type: "work",
      queue: "classification",
      payload: {},
      maxAttempts: 1,
      availableAt: "2026-01-01T00:00:00.000Z",
    });
    claimJob(db, "crashed-worker", "2026-01-01T00:00:00.000Z", "classification");

    expect(
      recoverStaleJobs(db, "2026-01-01T00:00:10.000Z", "2026-01-01T00:00:11.000Z", "classification")
    ).toBe(1);
    expect(listJobs(db, { status: "dead" })).toMatchObject([
      { id: job.id, lastError: "Job lock went stale." },
    ]);
  });

  test("starts separate classification, delivery, and execution loops", async () => {
    const db = createDatabase();
    for (const queue of ["classification", "delivery", "execution"]) {
      enqueueJob(db, {
        type: queue,
        queue,
        payload: { queue },
        maxAttempts: 1,
        availableAt: "2026-01-01T00:00:00.000Z",
      });
    }

    const handled: string[] = [];
    let finishHandlers!: () => void;
    const handlersFinished = new Promise<void>((resolve) => {
      finishHandlers = resolve;
    });
    const recordQueue = (job: { queue: string }) => {
      handled.push(job.queue);
      if (handled.length === 3) finishHandlers();
    };
    const workers = startWorkers(
      db,
      {
        classification: recordQueue,
        delivery: recordQueue,
        execution: recordQueue,
      },
      workerSettings(() => new Date("2026-01-01T00:01:00.000Z"))
    );

    await handlersFinished;
    await workers.stop();

    expect(handled.sort()).toEqual(["classification", "delivery", "execution"]);
    expect(listJobs(db, { status: "succeeded" })).toHaveLength(3);
  });
});

describe("exponential backoff", () => {
  test("grows from the base delay and stops at the cap", () => {
    expect(exponentialBackoff(1)).toBe(DEFAULT_BACKOFF_BASE_MS);
    expect(exponentialBackoff(2)).toBe(DEFAULT_BACKOFF_BASE_MS * 2);
    expect(exponentialBackoff(3)).toBe(DEFAULT_BACKOFF_BASE_MS * 4);
    expect(exponentialBackoff(20)).toBe(DEFAULT_BACKOFF_CAP_MS);
    expect(exponentialBackoff(3, { baseDelayMs: 100, maxDelayMs: 250 })).toBe(250);
  });
});
