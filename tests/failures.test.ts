import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { AdminActionError } from "../src/lib/server/admin-error";
import { handleAdminAction, handleAdminRead, loadFailures } from "../src/lib/server/api/admin";
import { ProviderError } from "../src/lib/server/classifier/types";
import { createClassificationHandler } from "../src/lib/server/classifier/worker";
import { loadConfig } from "../src/lib/server/config";
import { openDatabase } from "../src/lib/server/db";
import { listAttemptsForEvent } from "../src/lib/server/db/repositories/attempts";
import { getDelivery } from "../src/lib/server/db/repositories/deliveries";
import { createEvent } from "../src/lib/server/db/repositories/events";
import {
  createEventRoute,
  createIntegration,
} from "../src/lib/server/db/repositories/integrations";
import { enqueueJob, getJob } from "../src/lib/server/db/repositories/jobs";
import { listFailures, retryClassification, retryDelivery } from "../src/lib/server/failures";
import { createIntegrationRegistry } from "../src/lib/server/integrations/registry";
import { createLogger } from "../src/lib/server/logging";
import { createClassificationWorker, createDeliveryWorker } from "../src/lib/server/queue/workers";
import {
  createDeliveryRetryHandler,
  createRoutingService,
} from "../src/lib/server/routing/service";
import { fakeJev, fakeLuna } from "./classifier-fakes";

let db: Database;
let current: Date;
const now = () => current;
const settings = { pollIntervalMs: 1_000, staleAfterMs: 60_000, backoff: () => 1_000, now };

beforeEach(() => {
  db = openDatabase(":memory:");
  current = new Date("2026-09-26T12:00:00.000Z");
});

afterEach(() => {
  db.close();
});

/** Run a classification job with one attempt against a provider that fails, then succeeds. */
async function failClassification() {
  const event = createEvent(db, {
    id: "capture-1",
    source: "pebble",
    type: "pebble.transcription",
    payload: {},
    text: "Buy milk",
  });
  const job = enqueueJob(db, {
    type: "classify",
    queue: "classification",
    payload: { eventId: event.id },
    eventId: event.id,
    maxAttempts: 1,
    availableAt: current.toISOString(),
  });
  const handler = createClassificationHandler({
    db,
    jev: fakeJev(new ProviderError("typesafe", "service unavailable"), {
      action_type: "task",
      coding_executor: "unspecified",
      reminder_time: "missing",
    }),
    luna: fakeLuna({ type: "task.create", title: "Buy milk", notes: null, dueAt: null }),
  });
  const worker = createClassificationWorker(db, handler, settings);
  await worker.runOnce();
  return { event, job, worker };
}

/** Route a task to a Mail owner that rejects it, so the delivery is dead. */
async function failDelivery() {
  let status = 422;
  const mail = createIntegration(db, {
    name: "Mail",
    kind: "mail",
    baseUrl: "https://mail.test",
    config: {},
  });
  createEventRoute(db, { actionType: "task.create", integrationId: mail.id, config: {} });
  const event = createEvent(db, {
    id: "capture-2",
    source: "pebble",
    type: "pebble.transcription",
    payload: {},
  });
  const routing = createRoutingService({
    db,
    registry: createIntegrationRegistry({
      mailTransport: async () =>
        status === 422
          ? { status, body: { error: "title is required" } }
          : { status, body: { id: "task-1" } },
    }),
    now,
    log: createLogger(() => {}),
  });
  const outcome = await routing.routeAction(event, {
    type: "task.create",
    title: "Buy tea",
    notes: null,
    dueAt: null,
  });
  if (outcome.status === "unrouted") throw new Error("The test route did not match.");
  const worker = createDeliveryWorker(db, createDeliveryRetryHandler(routing), settings);
  return { event, delivery: outcome.delivery, worker, recover: () => (status = 201) };
}

describe("failures", () => {
  test("list a failed classification and retry it through the classification queue", async () => {
    const { event, job, worker } = await failClassification();

    expect(getJob(db, job.id)?.status).toBe("dead");
    expect(listFailures(db).classifications).toEqual([
      {
        jobId: job.id,
        eventId: event.id,
        source: "pebble",
        eventType: "pebble.transcription",
        attempts: 1,
        lastError: "service unavailable",
        failedAt: expect.any(String),
      },
    ]);

    retryClassification(db, event.id, current.toISOString());
    expect(getJob(db, job.id)).toMatchObject({ status: "pending", attempts: 0 });
    expect(listFailures(db).classifications).toEqual([]);

    await worker.runOnce();

    expect(getJob(db, job.id)?.status).toBe("succeeded");
    expect(listAttemptsForEvent(db, event.id).map((attempt) => attempt.status)).toEqual([
      "needs_review",
      "succeeded",
    ]);
  });

  test("list a dead delivery and retry it through the delivery queue", async () => {
    const { event, delivery, worker, recover } = await failDelivery();

    expect(listFailures(db).deliveries).toEqual([
      {
        deliveryId: delivery.id,
        eventId: event.id,
        source: "pebble",
        actionType: "task.create",
        destination: "Mail",
        attempts: 1,
        lastError: expect.stringContaining("HTTP 422"),
        failedAt: expect.any(String),
      },
    ]);

    retryDelivery(db, delivery.id, current.toISOString());
    expect(getDelivery(db, delivery.id)).toMatchObject({ status: "failed", attempts: 0 });
    expect(listFailures(db).deliveries).toEqual([]);

    recover();
    expect(await worker.runOnce()).toBe(true);

    expect(getDelivery(db, delivery.id)).toMatchObject({
      status: "succeeded",
      attempts: 1,
      response: { status: 201, downstreamId: "task-1" },
    });
    const results = db
      .query<{ status: string }, [string]>(
        "SELECT status FROM action_results WHERE event_id = ? ORDER BY rowid"
      )
      .all(event.id);
    expect(results.map((row) => row.status)).toEqual(["failed", "succeeded"]);
  });

  test("reject a retry of an item that is not failed, or that does not exist", async () => {
    const { event, job, worker } = await failClassification();
    retryClassification(db, event.id, current.toISOString());
    await worker.runOnce();
    expect(getJob(db, job.id)?.status).toBe("succeeded");

    expect(() => retryClassification(db, event.id)).toThrow(
      new AdminActionError(409, `The classification of event ${event.id} is succeeded.`)
    );
    expect(() => retryClassification(db, "missing")).toThrow(AdminActionError);

    const { delivery } = await failDelivery();
    retryDelivery(db, delivery.id, current.toISOString());
    expect(() => retryDelivery(db, delivery.id)).toThrow(
      new AdminActionError(409, `Delivery ${delivery.id} is failed.`)
    );
    expect(() => retryDelivery(db, "missing")).toThrow(AdminActionError);
  });
});

describe("failure APIs", () => {
  const credentials = {
    reader: { token: "reader-token", capabilities: ["admin:read"] },
    operator: { token: "operator-token", capabilities: ["admin:read", "admin:retry"] },
  };

  function context() {
    const config = loadConfig({
      PUBLIC_PORT: "4310",
      INTERNAL_PORT: "4311",
      DATABASE_PATH: ":memory:",
      PEBBLE_WEBHOOK_SECRETS: "secret",
      INTERNAL_SERVICE_CREDENTIALS: JSON.stringify(credentials),
      DEFAULT_EXECUTOR: "codex",
      CODEX_EXECUTABLE: "codex",
      CLAUDE_EXECUTABLE: "claude",
    });
    return { config, db };
  }

  function request(token: string | null, method = "GET") {
    return new Request("http://relay.local/api/test", {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  test("GET /api/failures requires admin:read", async () => {
    await failDelivery();

    expect(handleAdminRead(context(), request(null), loadFailures).status).toBe(401);
    const response = handleAdminRead(context(), request("reader-token"), loadFailures);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      classifications: [],
      deliveries: [{ eventId: "capture-2", destination: "Mail" }],
    });
  });

  test("retries require admin:retry and report 404 and 409", async () => {
    const { event } = await failClassification();
    const { delivery } = await failDelivery();
    const retry = (token: string | null, run: (db: Database) => unknown) =>
      handleAdminAction(context(), request(token, "POST"), run);
    const retryEvent = (db: Database) => ({ job: retryClassification(db, event.id) });

    expect((await retry(null, retryEvent)).status).toBe(401);
    expect((await retry("reader-token", retryEvent)).status).toBe(403);
    expect(getJob(db, listFailures(db).classifications[0].jobId)?.status).toBe("dead");

    const accepted = await retry("operator-token", retryEvent);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ job: { status: "pending", attempts: 0 } });

    const conflict = await retry("operator-token", retryEvent);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: `The classification of event ${event.id} is pending.`,
    });

    const deliveryResponse = await retry("operator-token", (db) => ({
      delivery: retryDelivery(db, delivery.id),
    }));
    expect(deliveryResponse.status).toBe(202);
    expect(await deliveryResponse.json()).toMatchObject({ delivery: { status: "failed" } });
    expect((await retry("operator-token", (db) => retryDelivery(db, "missing"))).status).toBe(404);
  });
});
