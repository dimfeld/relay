import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createClassificationHandler } from "../src/lib/server/classifier/worker";
import { ProviderError } from "../src/lib/server/classifier/types";
import { loadConfig } from "../src/lib/server/config";
import { createAttempt } from "../src/lib/server/db/repositories/attempts";
import { backupDatabase } from "../src/lib/server/db/backup";
import { createDelivery } from "../src/lib/server/db/repositories/deliveries";
import { createExecution, appendExecutionLog } from "../src/lib/server/db/repositories/executions";
import { openDatabase } from "../src/lib/server/db";
import { pruneExpiredHistory } from "../src/lib/server/db/retention";
import { createEvent } from "../src/lib/server/db/repositories/events";
import {
  createIntegration,
  createEventRoute,
} from "../src/lib/server/db/repositories/integrations";
import { enqueueJob, getJob } from "../src/lib/server/db/repositories/jobs";
import { createProject } from "../src/lib/server/db/repositories/projects";
import type { HttpRequest } from "../src/lib/server/integrations/types";
import { createIntegrationRegistry } from "../src/lib/server/integrations/registry";
import { createLogger } from "../src/lib/server/logging";
import { createOperationalMetrics } from "../src/lib/server/logging/metrics";
import { createClassificationWorker } from "../src/lib/server/queue/workers";
import {
  createOnClassifiedCallback,
  createRoutingService,
} from "../src/lib/server/routing/service";
import { createPublicServer } from "../src/public-webhook-server";
import { fakeJev, fakeLuna } from "./classifier-fakes";

const databases: Database[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.length = 0;
});

function testDatabase() {
  const db = openDatabase(":memory:");
  databases.push(db);
  return db;
}

function testConfig() {
  return loadConfig({
    PUBLIC_PORT: "4310",
    INTERNAL_PORT: "4311",
    DATABASE_PATH: ":memory:",
    PEBBLE_WEBHOOK_SECRETS: "secret",
    INTERNAL_SERVICE_CREDENTIALS: '{"mail":{"token":"token","capabilities":["events:publish"]}}',
    DEFAULT_EXECUTOR: "codex",
    CODEX_EXECUTABLE: "codex",
    CLAUDE_EXECUTABLE: "claude",
  });
}

function pebbleBody() {
  const boundary = "observability-boundary";
  const parts = [
    ["client", "test-watch"],
    ["recordedAt", "1780000000123"],
    ["transcription", "Remind me to buy tea."],
  ].map(
    ([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  );
  return {
    boundary,
    body: `${parts.join("")}--${boundary}--\r\n`,
  };
}

test("traces a Pebble event through classification, routing, and delivery", async () => {
  const db = testDatabase();
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  const metrics = createOperationalMetrics();
  const mail = createIntegration(db, {
    name: "Mail",
    kind: "mail",
    baseUrl: "https://mail.test",
    config: {},
  });
  createEventRoute(db, { actionType: "task.create", integrationId: mail.id, config: {} });
  const requests: HttpRequest[] = [];
  const routing = createRoutingService({
    db,
    log: logger,
    metrics,
    registry: createIntegrationRegistry({
      mailTransport: async (request) => {
        requests.push(request);
        return { status: 201, body: { id: "mail-task-1" } };
      },
    }),
  });
  const server = createPublicServer(testConfig(), db, 0, logger, metrics);

  try {
    const { boundary, body } = pebbleBody();
    const response = await fetch(new URL("/webhooks/pebble", server.url), {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    expect(response.status).toBe(202);
    const { eventId } = (await response.json()) as { eventId: string };
    const correlationId = response.headers.get("x-correlation-id")!;
    const handler = createClassificationHandler({
      db,
      jev: fakeJev({
        coding_executor: "unspecified",
        reminder_time: "missing",
        action_type: "task",
      }),
      luna: fakeLuna({ type: "task.create", title: "Buy tea", notes: null, dueAt: null }),
      onClassified: createOnClassifiedCallback(db, routing),
      log: logger,
      metrics,
    });
    const worker = createClassificationWorker(db, handler, {
      pollIntervalMs: 1_000,
      staleAfterMs: 60_000,
    });

    expect(await worker.runOnce()).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers["X-Correlation-ID"]).toBe(correlationId);
    expect(
      db
        .query<{ metadata: string }, [string]>("SELECT metadata FROM incoming_events WHERE id = ?")
        .get(eventId)?.metadata
    ).toContain(correlationId);

    const records = lines.map(
      (line) =>
        JSON.parse(line) as {
          correlationId: string | null;
          fields: { stage?: string };
        }
    );
    const pipelineRecords = records.filter((record) => record.fields.stage);
    expect(new Set(pipelineRecords.map((record) => record.fields.stage))).toEqual(
      new Set(["webhook", "ingest", "classification", "routing", "delivery"])
    );
    expect(pipelineRecords.every((record) => record.correlationId === correlationId)).toBe(true);
    expect(metrics.snapshot()).toMatchObject({
      incomingEvents: 1,
      classifier: { runs: 1, failures: 0, latencyMs: { count: 1 } },
      deliveryRetries: 0,
    });
  } finally {
    await server.stop();
  }
});

test("counts classifier failures and scheduled delivery retries", async () => {
  const db = testDatabase();
  const metrics = createOperationalMetrics();
  const failedEvent = createEvent(db, {
    source: "test",
    type: "pebble.transcription",
    payload: {},
    text: "Buy tea",
    metadata: { correlationId: "failed-classifier" },
  });
  const job = enqueueJob(db, {
    type: "classify",
    queue: "classification",
    payload: { eventId: failedEvent.id },
    eventId: failedEvent.id,
    maxAttempts: 2,
  });
  const handler = createClassificationHandler({
    db,
    jev: fakeJev(new ProviderError("typesafe", "service unavailable")),
    luna: fakeLuna({}),
    metrics,
  });
  await createClassificationWorker(db, handler, {
    pollIntervalMs: 1_000,
    staleAfterMs: 60_000,
  }).runOnce();
  expect(getJob(db, job.id)).toMatchObject({ status: "pending", attempts: 1 });

  const retryEvent = createEvent(db, {
    source: "test",
    type: "test.event",
    payload: {},
    metadata: { correlationId: "delivery-retry" },
  });
  const mail = createIntegration(db, {
    name: "Mail",
    kind: "mail",
    baseUrl: "https://mail.test",
    config: {},
  });
  createEventRoute(db, { actionType: "task.create", integrationId: mail.id, config: {} });
  const routing = createRoutingService({
    db,
    metrics,
    now: () => new Date("2026-09-26T12:00:00.000Z"),
    backoff: () => 1_000,
    registry: createIntegrationRegistry({
      mailTransport: async () => ({ status: 503, body: { error: "busy" } }),
    }),
  });
  await routing.routeAction(retryEvent, {
    type: "task.create",
    title: "Buy tea",
    notes: null,
    dueAt: null,
  });

  expect(metrics.snapshot()).toMatchObject({
    classifier: { runs: 1, failures: 1, latencyMs: { count: 1 } },
    deliveryRetries: 1,
  });
});

test("prunes expired event history and bounds stored execution logs", () => {
  const db = testDatabase();
  const oldEvent = createEvent(db, {
    source: "test",
    sourceEventId: "old",
    type: "test.event",
    receivedAt: "2025-12-01T00:00:00.000Z",
    payload: { raw: "old payload" },
  });
  const currentEvent = createEvent(db, {
    source: "test",
    sourceEventId: "current",
    type: "test.event",
    receivedAt: "2026-09-25T00:00:00.000Z",
    payload: { raw: "current payload" },
  });
  createAttempt(db, {
    eventId: oldEvent.id,
    stage: "classification",
    status: "failed",
    startedAt: "2025-12-01T00:00:00.000Z",
  });
  createAttempt(db, {
    eventId: currentEvent.id,
    stage: "classification",
    status: "running",
    startedAt: "2026-09-25T00:00:00.000Z",
  });
  enqueueJob(db, {
    type: "classify",
    queue: "classification",
    payload: { eventId: oldEvent.id },
    eventId: oldEvent.id,
    maxAttempts: 5,
    availableAt: "2025-12-01T00:00:00.000Z",
  });
  enqueueJob(db, {
    type: "classify",
    queue: "classification",
    payload: { eventId: currentEvent.id },
    eventId: currentEvent.id,
    maxAttempts: 5,
    availableAt: "2026-09-25T00:00:00.000Z",
  });
  const mail = createIntegration(db, {
    name: "Mail",
    kind: "mail",
    baseUrl: "https://mail.test",
    config: {},
  });
  const retryableDelivery = createDelivery(db, {
    eventId: currentEvent.id,
    integrationId: mail.id,
    status: "failed",
    attempts: 1,
    nextAttemptAt: "2026-09-26T00:00:00.000Z",
    idempotencyKey: "retryable-delivery",
    request: { correlationId: "current" },
  });
  const project = createProject(db, {
    name: "Relay",
    path: "/srv/relay",
    defaultBranch: "main",
    executor: "codex",
    config: {},
  });
  const oldExecution = createExecution(db, {
    projectId: project.id,
    eventId: oldEvent.id,
    executor: "codex",
    status: "succeeded",
    prompt: "old run",
  });
  const activeExecution = createExecution(db, {
    projectId: project.id,
    eventId: currentEvent.id,
    executor: "codex",
    status: "running",
    prompt: "current run",
  });
  appendExecutionLog(db, {
    executionId: oldExecution.id,
    seq: 0,
    ts: "2025-12-01T00:00:00.000Z",
    stream: "stdout",
    message: "old output",
  });
  appendExecutionLog(db, {
    executionId: activeExecution.id,
    seq: 0,
    ts: "2025-12-01T00:00:00.000Z",
    stream: "stdout",
    message: "expired output from active run",
  });
  appendExecutionLog(db, {
    executionId: activeExecution.id,
    seq: 1,
    ts: "2026-09-25T00:00:00.000Z",
    stream: "stdout",
    message: "recent output",
  });

  const counts = pruneExpiredHistory(db, "2026-01-01T00:00:00.000Z");

  expect(counts.events).toBe(1);
  expect(counts.attempts).toBe(1);
  expect(counts.jobs).toBe(1);
  expect(counts.executionLogs).toBe(2);
  expect(
    db
      .query<{ id: string }, []>("SELECT id FROM incoming_events")
      .all()
      .map((row) => row.id)
  ).toEqual([currentEvent.id]);
  expect(
    db
      .query<{ status: string }, [string]>("SELECT status FROM deliveries WHERE id = ?")
      .get(retryableDelivery.id)?.status
  ).toBe("failed");
  expect(
    db
      .query<{ message: string }, [string]>(
        "SELECT message FROM execution_logs WHERE execution_id = ?"
      )
      .all(activeExecution.id)
      .map((row) => row.message)
  ).toEqual(["recent output"]);
});

test("creates a readable SQLite backup with the source data", () => {
  const db = testDatabase();
  const directory = mkdtempSync(join(tmpdir(), "relay-backup-"));
  directories.push(directory);
  const event = createEvent(db, {
    source: "test",
    type: "test.event",
    payload: { retained: true },
  });
  const destination = join(directory, "backups", "relay.sqlite");
  const backupPath = backupDatabase(db, destination);
  const backup = new Database(backupPath, { readonly: true });
  try {
    expect(
      backup
        .query<{ id: string; payload: string }, [string]>(
          "SELECT id, payload FROM incoming_events WHERE id = ?"
        )
        .get(event.id)
    ).toEqual({ id: event.id, payload: '{"retained":true}' });
  } finally {
    backup.close();
  }
});
