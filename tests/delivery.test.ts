import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/lib/server/db";
import { getDelivery } from "../src/lib/server/db/repositories/deliveries";
import { createEvent, type IncomingEvent } from "../src/lib/server/db/repositories/events";
import {
  createEventRoute,
  createIntegration,
} from "../src/lib/server/db/repositories/integrations";
import { listJobs } from "../src/lib/server/db/repositories/jobs";
import { createIntegrationRegistry } from "../src/lib/server/integrations/registry";
import type { HttpTransport } from "../src/lib/server/integrations/types";
import { createLogger } from "../src/lib/server/logging";
import { createDeliveryWorker } from "../src/lib/server/queue/workers";
import { MAX_RECORDED_BODY_CHARS } from "../src/lib/server/routing/response";
import {
  createDeliveryRetryHandler,
  createRoutingService,
  type DeliveryOutcome,
  type RoutingOutcome,
  type RoutingService,
} from "../src/lib/server/routing/service";

const HOUR_MS = 60 * 60 * 1_000;

let db: Database;
let current: Date;
let logLines: string[];
const now = () => current;

beforeEach(() => {
  db = openDatabase(":memory:");
  current = new Date("2026-09-26T12:00:00.000Z");
  logLines = [];
});

afterEach(() => {
  db.close();
});

function setup(transport: HttpTransport, maxAttempts = 5) {
  const mail = createIntegration(db, {
    name: "Mail",
    kind: "mail",
    baseUrl: "https://mail.test",
    config: {},
  });
  createEventRoute(db, { actionType: "task.create", integrationId: mail.id, config: {} });
  const event = createEvent(db, {
    id: "event-1",
    source: "test",
    type: "pebble.transcription",
    payload: {},
  });
  const service = createRoutingService({
    db,
    registry: createIntegrationRegistry({ mailTransport: transport }),
    maxAttempts,
    now,
    log: createLogger((line) => logLines.push(line)),
  });
  const worker = createDeliveryWorker(db, createDeliveryRetryHandler(service), {
    pollIntervalMs: 1_000,
    staleAfterMs: 60_000,
    now,
  });
  return { event, service, worker };
}

async function routeTask(service: RoutingService, event: IncomingEvent): Promise<DeliveryOutcome> {
  const outcome: RoutingOutcome = await service.routeAction(event, {
    type: "task.create",
    title: "Buy tea",
    notes: null,
    dueAt: null,
  });
  if (outcome.status === "unrouted") throw new Error("The test route did not match.");
  return outcome;
}

/** Move the clock past any scheduled retry and let the delivery worker run one job. */
async function runDueRetry(worker: ReturnType<typeof setup>["worker"]) {
  current = new Date(current.getTime() + HOUR_MS);
  expect(await worker.runOnce()).toBe(true);
}

function actionResultStatuses(eventId: string): string[] {
  return db
    .query<{ status: string }, [string]>(
      "SELECT status FROM action_results WHERE event_id = ? ORDER BY rowid"
    )
    .all(eventId)
    .map((row) => row.status);
}

describe("durable delivery", () => {
  test("retries automatically after an outage with the same idempotency key", async () => {
    const keys: string[] = [];
    let outageCalls = 2;
    const { event, service, worker } = setup(async (request) => {
      keys.push(request.headers["Idempotency-Key"]!);
      if (outageCalls > 0) {
        outageCalls -= 1;
        throw new Error("connection refused");
      }
      return { status: 201, body: { id: "task-1" } };
    });

    const first = await routeTask(service, event);
    expect(first.delivery).toMatchObject({ status: "failed", attempts: 1, response: null });
    // The worker does nothing until the retry is due.
    expect(await worker.runOnce()).toBe(false);

    await runDueRetry(worker);
    expect(getDelivery(db, first.delivery.id)).toMatchObject({ status: "failed", attempts: 2 });
    await runDueRetry(worker);

    expect(getDelivery(db, first.delivery.id)).toMatchObject({
      status: "succeeded",
      attempts: 3,
      nextAttemptAt: null,
      lastError: null,
      response: { status: 201, downstreamId: "task-1" },
    });
    expect(keys).toEqual(Array(3).fill(first.delivery.idempotencyKey));
    expect(actionResultStatuses(event.id)).toEqual(["succeeded"]);
  });

  test("keeps a permanent failure visible as dead and retries it manually", async () => {
    let status = 422;
    const keys: string[] = [];
    const { event, service } = setup(async (request) => {
      keys.push(request.headers["Idempotency-Key"]!);
      return status === 422
        ? { status, body: { error: "title is required" } }
        : { status, body: { id: "task-1" } };
    });

    const outcome = await routeTask(service, event);

    expect(outcome.delivery).toMatchObject({
      status: "dead",
      attempts: 1,
      nextAttemptAt: null,
      lastError: expect.stringContaining("HTTP 422"),
      response: { status: 422, body: { error: "title is required" }, bodyTruncated: false },
    });
    expect(listJobs(db, { queue: "delivery" })).toHaveLength(0);

    status = 201;
    const retried = await service.retryDelivery(outcome.delivery.id);

    expect(retried.delivery).toMatchObject({
      status: "succeeded",
      response: { status: 201, downstreamId: "task-1" },
    });
    expect(keys).toEqual([outcome.delivery.idempotencyKey, outcome.delivery.idempotencyKey]);
    expect(actionResultStatuses(event.id)).toEqual(["failed", "succeeded"]);
  });

  test("moves a delivery to dead after the configured attempts, then retries it manually", async () => {
    let available = false;
    const { event, service, worker } = setup(
      async () =>
        available
          ? { status: 201, body: { id: "task-1" } }
          : { status: 503, body: { error: "down" } },
      2
    );

    const first = await routeTask(service, event);
    expect(first.status).toBe("failed");
    await runDueRetry(worker);

    expect(getDelivery(db, first.delivery.id)).toMatchObject({
      status: "dead",
      attempts: 2,
      nextAttemptAt: null,
      lastError: expect.stringContaining("HTTP 503"),
      response: { status: 503, body: { error: "down" } },
    });
    expect(actionResultStatuses(event.id)).toEqual(["failed"]);

    available = true;
    const retried = await service.retryDelivery(first.delivery.id);

    expect(retried.delivery).toMatchObject({ status: "succeeded", attempts: 1 });
  });

  test("does not create a duplicate object when a response is lost", async () => {
    // This fake owner honors Idempotency-Key: it stores at most one object per key.
    const objects = new Map<string, { id: string }>();
    let lostResponses = 2;
    let requests = 0;
    const { event, service, worker } = setup(async (request) => {
      requests += 1;
      const key = request.headers["Idempotency-Key"]!;
      const object = objects.get(key) ?? { id: `task-${objects.size + 1}` };
      objects.set(key, object);
      if (lostResponses > 0) {
        lostResponses -= 1;
        return { status: 504, body: { error: "gateway timeout" } };
      }
      return { status: 200, body: object };
    });

    const first = await routeTask(service, event);
    expect(first.status).toBe("failed");
    await runDueRetry(worker);
    const manual = await service.retryDelivery(first.delivery.id);
    const rerouted = await routeTask(service, event);

    expect(requests).toBe(3);
    expect(objects.size).toBe(1);
    expect(manual.delivery.response?.downstreamId).toBe("task-1");
    expect(rerouted.delivery.id).toBe(first.delivery.id);
    expect(rerouted.status).toBe("succeeded");
  });

  test("bounds stored response bodies and keeps secrets out of storage and logs", async () => {
    const { event, service } = setup(async () => ({
      status: 400,
      body: {
        authorization: "Bearer owner-secret",
        details: { apiKey: "owner-secret" },
        message: "x".repeat(MAX_RECORDED_BODY_CHARS * 2),
      },
    }));

    const outcome = await routeTask(service, event);

    expect(outcome.delivery.response?.bodyTruncated).toBe(true);
    expect(outcome.delivery.response?.body).toBeString();
    expect(String(outcome.delivery.response?.body)).toHaveLength(MAX_RECORDED_BODY_CHARS);
    expect(String(outcome.delivery.response?.body)).toContain("[redacted]");
    const row = db.query("SELECT * FROM deliveries").get();
    expect(JSON.stringify(row)).not.toContain("owner-secret");
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join("\n")).not.toContain("owner-secret");
  });
});
