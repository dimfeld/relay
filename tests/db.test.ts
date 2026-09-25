import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import * as eventsRepository from "../src/lib/server/db/repositories/events";
import {
  createAttempt,
  getAttempt,
  updateAttempt,
} from "../src/lib/server/db/repositories/attempts";
import {
  createClassification,
  getClassification,
  updateClassification,
} from "../src/lib/server/db/repositories/classifications";
import {
  createActionResult,
  getActionResult,
  updateActionResult,
} from "../src/lib/server/db/repositories/actionResults";
import {
  deleteConfiguration,
  getConfiguration,
  setConfiguration,
} from "../src/lib/server/db/repositories/configuration";
import {
  createDelivery,
  getDelivery,
  updateDelivery,
} from "../src/lib/server/db/repositories/deliveries";
import {
  appendExecutionLog,
  createExecution,
  getExecution,
  getExecutionLog,
  listExecutionLogs,
  updateExecution,
} from "../src/lib/server/db/repositories/executions";
import {
  createEventRoute,
  createIntegration,
  getEventRoute,
  getIntegration,
  updateEventRoute,
  updateIntegration,
} from "../src/lib/server/db/repositories/integrations";
import {
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  getJob,
} from "../src/lib/server/db/repositories/jobs";
import {
  createProject,
  getProject,
  updateProject,
} from "../src/lib/server/db/repositories/projects";
import { migrations } from "../src/lib/server/db/migrations";
import { openDatabase, runMigrations } from "../src/lib/server/db";

let db: Database;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("SQLite migrations", () => {
  test("builds all expected tables, indexes, and database settings from migrations", () => {
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map(({ name }) => name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "schema_migrations",
        "incoming_events",
        "processing_attempts",
        "jobs",
        "classifications",
        "integrations",
        "event_routes",
        "deliveries",
        "projects",
        "executions",
        "execution_logs",
        "action_results",
        "configuration",
      ])
    );

    const indexes = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map(({ name }) => name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "incoming_events_received_at_idx",
        "incoming_events_type_received_at_idx",
        "jobs_claim_idx",
        "deliveries_pending_idx",
        "executions_status_created_idx",
      ])
    );
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(
      1
    );
  });

  test("applies each migration once when run more than once", () => {
    runMigrations(db);
    runMigrations(db);
    const applied = db
      .query<{ version: number; name: string }, []>(
        "SELECT version, name FROM schema_migrations ORDER BY version"
      )
      .all();
    expect(applied).toHaveLength(migrations.length);
    expect(new Set(applied.map(({ version }) => version)).size).toBe(migrations.length);
  });

  test("opens file databases in WAL mode and migrates a fresh file", () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-db-"));
    const fileDb = openDatabase(join(directory, "relay.sqlite"));
    try {
      expect(
        fileDb.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode
      ).toBe("wal");
      expect(
        fileDb
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'incoming_events'"
          )
          .get()
      ).toEqual({
        name: "incoming_events",
      });
    } finally {
      fileDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("database repositories", () => {
  test("stores and reads events, rejects duplicates, and keeps original fields immutable", () => {
    const event = eventsRepository.createEvent(db, {
      source: "pebble",
      sourceEventId: "capture-1",
      type: "transcription",
      receivedAt: "2026-01-01T00:00:00.000Z",
      payload: { raw: ["original", 1] },
      text: "hello",
      metadata: { locale: "en" },
    });
    expect(eventsRepository.getEvent(db, event.id)).toEqual(event);
    expect(eventsRepository.findEventBySource(db, "pebble", "capture-1")).toEqual(event);
    expect("updateEvent" in eventsRepository).toBe(false);
    expect(() =>
      eventsRepository.createEvent(db, {
        source: "pebble",
        sourceEventId: "capture-1",
        type: "transcription",
        payload: { duplicate: true },
      })
    ).toThrow();
    expect(() =>
      db
        .query("UPDATE incoming_events SET payload = ? WHERE id = ?")
        .run('{"raw":["changed"]}', event.id)
    ).toThrow(/original event fields are immutable/);
    expect(() =>
      db
        .query("UPDATE incoming_events SET source_event_id = ? WHERE id = ?")
        .run("changed", event.id)
    ).toThrow(/original event fields are immutable/);
    expect(eventsRepository.getEvent(db, event.id)?.payload).toEqual({ raw: ["original", 1] });
  });

  test("creates and updates processing attempts", () => {
    const event = makeEvent();
    const attempt = createAttempt(db, { eventId: event.id, stage: "classify", status: "running" });
    expect(getAttempt(db, attempt.id)).toEqual(attempt);
    expect(
      updateAttempt(db, attempt.id, {
        status: "succeeded",
        finishedAt: "2026-01-01T00:01:00.000Z",
        details: { call: 1 },
      })
    ).toMatchObject({ status: "succeeded", details: { call: 1 } });
  });

  test("claims available jobs atomically and updates completion and retry state", () => {
    const first = enqueueJob(db, {
      type: "classify",
      queue: "classification",
      payload: { event: "one" },
      maxAttempts: 2,
      availableAt: "2026-01-01T00:00:00.000Z",
    });
    const second = enqueueJob(db, {
      type: "deliver",
      queue: "delivery",
      payload: { event: "two" },
      maxAttempts: 2,
      availableAt: "2026-01-01T00:00:00.000Z",
    });
    const claimedFirst = claimJob(db, "worker-1", "2026-01-01T00:01:00.000Z", "classification");
    expect(claimedFirst).toMatchObject({
      id: first.id,
      status: "running",
      attempts: 1,
      lockedBy: "worker-1",
    });
    expect(completeJob(db, first.id)).toMatchObject({ status: "succeeded", lockedBy: null });

    expect(claimJob(db, "worker-2", "2026-01-01T00:01:00.000Z")).toMatchObject({ id: second.id });
    expect(failJob(db, second.id, "temporary", "2026-01-01T00:02:00.000Z")).toMatchObject({
      status: "pending",
      lastError: "temporary",
    });
    expect(claimJob(db, "worker-2", "2026-01-01T00:02:00.000Z")).toMatchObject({ attempts: 2 });
    expect(failJob(db, second.id, "again")).toMatchObject({ status: "dead", attempts: 2 });
    expect(getJob(db, second.id)?.lastError).toBe("again");
    expect(claimJob(db, "worker-3", "2026-01-01T00:03:00.000Z")).toBeNull();
  });

  test("creates, reads, and updates classifications with model metadata", () => {
    const event = makeEvent();
    const classification = createClassification(db, {
      eventId: event.id,
      actionType: "task.create",
      result: { title: "Write tests" },
      provider: "typesafe",
      model: "jev-latest",
      confidence: 0.8,
      status: "validated",
      error: null,
    });
    expect(getClassification(db, classification.id)).toEqual(classification);
    expect(
      updateClassification(db, classification.id, { status: "needs_review", confidence: 0.5 })
    ).toMatchObject({
      status: "needs_review",
      confidence: 0.5,
    });
  });

  test("creates and updates integrations and event routes", () => {
    const integration = createIntegration(db, {
      name: "mail",
      kind: "http",
      baseUrl: "https://mail.test",
      config: { tokenRef: "MAIL_TOKEN" },
    });
    expect(getIntegration(db, integration.id)).toEqual(integration);
    expect(
      updateIntegration(db, integration.id, { enabled: false, config: { tokenRef: "NEW_TOKEN" } })
    ).toMatchObject({
      enabled: false,
      config: { tokenRef: "NEW_TOKEN" },
    });

    const route = createEventRoute(db, {
      actionType: "task.create",
      integrationId: integration.id,
      config: { path: "/tasks" },
    });
    expect(getEventRoute(db, route.id)).toEqual(route);
    expect(
      updateEventRoute(db, route.id, { actionType: "reminder.create", enabled: false })
    ).toMatchObject({
      actionType: "reminder.create",
      enabled: false,
    });
  });

  test("creates and updates deliveries", () => {
    const event = makeEvent();
    const integration = createIntegration(db, {
      name: "delivery-target",
      kind: "http",
      config: {},
    });
    const delivery = createDelivery(db, {
      eventId: event.id,
      integrationId: integration.id,
      idempotencyKey: "event-1-task.create",
      request: { title: "Task" },
    });
    expect(getDelivery(db, delivery.id)).toEqual(delivery);
    expect(
      updateDelivery(db, delivery.id, {
        status: "succeeded",
        attempts: 1,
        response: { id: "remote-1" },
      })
    ).toMatchObject({
      status: "succeeded",
      attempts: 1,
      response: { id: "remote-1" },
    });
  });

  test("creates and updates projects", () => {
    const project = createProject(db, {
      name: "Relay",
      path: "/work/relay",
      defaultBranch: "main",
      executor: "codex",
      config: { instructions: "Keep changes small" },
    });
    expect(getProject(db, project.id)).toEqual(project);
    expect(updateProject(db, project.id, { enabled: false, defaultBranch: "trunk" })).toMatchObject(
      {
        enabled: false,
        defaultBranch: "trunk",
      }
    );
  });

  test("creates and updates executions and reads ordered logs", () => {
    const project = createProject(db, {
      name: "Execution project",
      path: "/work/project",
      defaultBranch: "main",
      executor: "codex",
      config: {},
    });
    const execution = createExecution(db, {
      projectId: project.id,
      executor: "codex",
      prompt: "Fix the parser",
    });
    expect(getExecution(db, execution.id)).toEqual(execution);
    expect(
      updateExecution(db, execution.id, { status: "running", branch: "agent/fix-parser" })
    ).toMatchObject({
      status: "running",
      branch: "agent/fix-parser",
    });
    appendExecutionLog(db, {
      executionId: execution.id,
      seq: 2,
      stream: "stderr",
      level: "warn",
      message: "second",
    });
    const firstLog = appendExecutionLog(db, {
      executionId: execution.id,
      seq: 1,
      stream: "stdout",
      message: "first",
    });
    expect(getExecutionLog(db, firstLog.id)?.message).toBe("first");
    expect(listExecutionLogs(db, execution.id).map(({ message }) => message)).toEqual([
      "first",
      "second",
    ]);
  });

  test("creates and updates action results and configuration entries", () => {
    const event = makeEvent();
    const actionResult = createActionResult(db, {
      eventId: event.id,
      actionType: "task.create",
      status: "pending",
      result: { title: "Task" },
    });
    expect(getActionResult(db, actionResult.id)).toEqual(actionResult);
    expect(
      updateActionResult(db, actionResult.id, { status: "succeeded", result: { id: "remote-1" } })
    ).toMatchObject({
      status: "succeeded",
      result: { id: "remote-1" },
    });

    expect(setConfiguration(db, "wake-name", "Relay").value).toBe("Relay");
    expect(setConfiguration(db, "wake-name", "Riley").value).toBe("Riley");
    expect(getConfiguration(db, "wake-name")?.value).toBe("Riley");
    expect(deleteConfiguration(db, "wake-name")).toBe(true);
    expect(getConfiguration(db, "wake-name")).toBeNull();
  });
});

function makeEvent(): eventsRepository.IncomingEvent {
  return eventsRepository.createEvent(db, {
    source: "test",
    type: "transcription",
    payload: { text: "hello" },
  });
}
