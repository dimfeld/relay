import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { dispatchableAction } from "../src/lib/server/classifier/dispatch";
import type { Action } from "../src/lib/server/classifier/schemas";
import { ProviderError } from "../src/lib/server/classifier/types";
import { createClassificationHandler } from "../src/lib/server/classifier/worker";
import { openDatabase } from "../src/lib/server/db";
import { listAttemptsForEvent } from "../src/lib/server/db/repositories/attempts";
import {
  getClassification,
  type Classification,
} from "../src/lib/server/db/repositories/classifications";
import { createEvent, getEvent } from "../src/lib/server/db/repositories/events";
import { enqueueJob, getJob } from "../src/lib/server/db/repositories/jobs";
import { createProject } from "../src/lib/server/db/repositories/projects";
import { createClassificationWorker } from "../src/lib/server/queue/workers";
import { fakeJev, fakeLuna } from "./classifier-fakes";

let databases: Database[] = [];

afterEach(() => {
  for (const db of databases) db.close();
  databases = [];
});

const baseAnswers = { coding_executor: "unspecified", reminder_time: "missing" };

function setup(text: string, maxAttempts = 3) {
  const db = openDatabase(":memory:");
  databases.push(db);
  createProject(db, {
    name: "Relay",
    path: "/srv/relay",
    defaultBranch: "main",
    executor: "codex",
    config: { aliases: ["hub"] },
  });
  const event = createEvent(db, {
    source: "pebble",
    sourceEventId: "watch:1",
    type: "pebble.transcription",
    payload: { body: "raw" },
    text,
    metadata: { recordedAt: "2026-09-25T16:00:00.000Z" },
  });
  const job = enqueueJob(db, {
    type: "classify",
    queue: "classification",
    payload: { eventId: event.id },
    eventId: event.id,
    maxAttempts,
    availableAt: "2026-09-25T16:00:00.000Z",
  });
  let now = new Date("2026-09-25T16:00:00.000Z");
  const settings = {
    pollIntervalMs: 1_000,
    staleAfterMs: 60_000,
    backoff: () => 1_000,
    now: () => now,
  };
  const advance = () => {
    now = new Date(now.getTime() + 1_000);
  };
  return { db, event, job, settings, advance };
}

function classificationsFor(db: Database, eventId: string): Classification[] {
  return db
    .query<{ id: string }, [string]>(
      "SELECT id FROM classifications WHERE event_id = ? ORDER BY created_at"
    )
    .all(eventId)
    .map(({ id }) => getClassification(db, id)!);
}

describe("classification worker", () => {
  test("stores a validated action and dispatches it", async () => {
    const { db, event, job, settings } = setup("Tim, ask Codex to add dark mode to the hub");
    const dispatched: Action[] = [];
    const handler = createClassificationHandler({
      db,
      jev: fakeJev({ ...baseAnswers, action_type: "coding_request", coding_executor: "codex" }),
      luna: fakeLuna({ type: "command.execute", project: "hub", task: "Add dark mode" }),
      wakeName: "Tim",
      onClassified: (action) => void dispatched.push(action),
    });

    await createClassificationWorker(db, handler, settings).runOnce();

    expect(getJob(db, job.id)?.status).toBe("succeeded");
    const [classification] = classificationsFor(db, event.id);
    expect(classification).toMatchObject({
      actionType: "command.execute",
      status: "classified",
      provider: "fake-typesafe",
      model: "jev-test",
      confidence: 0.9,
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatchableAction(classification)).toEqual(dispatched[0]);
    expect(dispatched[0]).toMatchObject({
      command: { projectName: "Relay", requestedExecutor: { provider: "codex" } },
    });

    const [attempt] = listAttemptsForEvent(db, event.id);
    expect(attempt.status).toBe("succeeded");
    expect(attempt.details).toMatchObject({
      classificationId: classification.id,
      selectedContextIds: [],
      signals: { wakeNameDetected: true },
      jev: { provider: "fake-typesafe", model: "jev-test", latencyMs: 12, label: "coding_request" },
      luna: [{ provider: "fake-openai", model: "luna-test", latencyMs: 34, valid: true }],
      reason: "classified as command.execute",
    });
  });

  test("never dispatches an invalid result", async () => {
    const { db, event, settings } = setup("Tim, run the deploy script in Gizmo");
    const dispatched: Action[] = [];
    const handler = createClassificationHandler({
      db,
      jev: fakeJev({ ...baseAnswers, action_type: "coding_request" }),
      luna: fakeLuna({ type: "command.execute", project: "Gizmo", task: "Deploy" }),
      onClassified: (action) => void dispatched.push(action),
    });

    await createClassificationWorker(db, handler, settings).runOnce();

    const [classification] = classificationsFor(db, event.id);
    expect(classification.status).toBe("needs_review");
    expect(classification.error).toBe("coding request does not name a registered project");
    expect(dispatchableAction(classification)).toBeNull();
    expect(dispatched).toEqual([]);
    expect(listAttemptsForEvent(db, event.id)[0].status).toBe("needs_review");
  });

  test("dispatchableAction rejects classifications with invalid stored actions", () => {
    const base = {
      id: "c1",
      eventId: "e1",
      provider: "typesafe",
      model: "jev",
      confidence: null,
      error: null,
      createdAt: "",
    };
    expect(
      dispatchableAction({
        ...base,
        actionType: "task.create",
        status: "classified",
        result: { action: { type: "task.create", title: "" } },
      })
    ).toBeNull();
    expect(
      dispatchableAction({
        ...base,
        actionType: "task.create",
        status: "classified",
        result: { action: { type: "unknown", reason: "mismatch" } },
      })
    ).toBeNull();
  });

  test("keeps the event and creates a new attempt for each retry after provider failures", async () => {
    const { db, event, job, settings, advance } = setup("Buy milk", 2);
    const dispatched: Action[] = [];
    const handler = createClassificationHandler({
      db,
      jev: fakeJev(new ProviderError("typesafe", "service unavailable")),
      luna: fakeLuna(),
      onClassified: (action) => void dispatched.push(action),
    });
    const worker = createClassificationWorker(db, handler, settings);

    await worker.runOnce();
    expect(getJob(db, job.id)?.status).toBe("pending");
    advance();
    await worker.runOnce();

    expect(getJob(db, job.id)).toMatchObject({ status: "dead", lastError: "service unavailable" });
    expect(listAttemptsForEvent(db, event.id).map((attempt) => attempt.status)).toEqual([
      "failed",
      "needs_review",
    ]);
    expect(getEvent(db, event.id)).toEqual(event);
    expect(classificationsFor(db, event.id)).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  test("a later retry succeeds after an earlier provider failure", async () => {
    const { db, event, settings, advance } = setup("Buy milk");
    const handler = createClassificationHandler({
      db,
      jev: fakeJev(new ProviderError("typesafe", "timeout"), {
        ...baseAnswers,
        action_type: "task",
      }),
      luna: fakeLuna({ type: "task.create", title: "Buy milk", notes: null, dueAt: null }),
    });
    const worker = createClassificationWorker(db, handler, settings);
    await worker.runOnce();
    advance();
    await worker.runOnce();

    expect(listAttemptsForEvent(db, event.id).map((attempt) => attempt.status)).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(classificationsFor(db, event.id).map((row) => row.status)).toEqual(["classified"]);
  });
});
