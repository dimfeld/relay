import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  handleAdminRead,
  loadAttempts,
  loadDeliveries,
  loadEvent,
  loadEvents,
  loadExecution,
  loadExecutions,
  loadProject,
  loadProjects,
  type AdminLoader,
} from "../src/lib/server/api/admin";
import { handlePublishEvent } from "../src/lib/server/api/events";
import { loadConfig } from "../src/lib/server/config";
import type { ServerContext } from "../src/lib/server/context";
import { openDatabase } from "../src/lib/server/db";
import { getDelivery } from "../src/lib/server/db/repositories/deliveries";
import { createEvent, getEvent } from "../src/lib/server/db/repositories/events";
import { createExecution } from "../src/lib/server/db/repositories/executions";
import {
  createEventRoute,
  createIntegration,
} from "../src/lib/server/db/repositories/integrations";
import { claimJob, listJobs } from "../src/lib/server/db/repositories/jobs";
import { createProject } from "../src/lib/server/db/repositories/projects";
import { createIntegrationRegistry } from "../src/lib/server/integrations/registry";
import type { HttpRequest } from "../src/lib/server/integrations/types";
import {
  createDeliveryQueueHandler,
  createRoutingService,
  type RouteEventJobPayload,
} from "../src/lib/server/routing/service";

const credentials = {
  mail: { token: "mail-token", capabilities: ["events:publish"] },
  omniapp: { token: "omni-token", capabilities: ["events:publish", "coding:request"] },
  admin: { token: "admin-token", capabilities: ["admin:read"] },
};

let db: Database;
let context: ServerContext;

beforeEach(() => {
  db = openDatabase(":memory:");
  const config = loadConfig({
    PUBLIC_PORT: "4310",
    INTERNAL_PORT: "4311",
    DATABASE_PATH: ":memory:",
    PEBBLE_WEBHOOK_SECRETS: "secret",
    INTERNAL_SERVICE_CREDENTIALS: JSON.stringify(credentials),
    INTERNAL_API_MAX_BODY_BYTES: "512",
    DEFAULT_EXECUTOR: "codex",
    CODEX_EXECUTABLE: "codex",
    CLAUDE_EXECUTABLE: "claude",
  });
  context = { config, db };
});

afterEach(() => {
  db.close();
});

const packageEvent = {
  source: "mail",
  type: "package.detected",
  payload: { carrier: "ups", trackingNumber: "1Z999" },
  sourceEventId: "mail-message-1",
};

function publish(body: unknown, token: string | null = "mail-token", headers = {}) {
  const request = new Request("http://relay.local/api/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return handlePublishEvent(context, request, "correlation-1");
}

function eventCount(): number {
  return db.query<{ count: number }, []>("SELECT count(*) AS count FROM incoming_events").get()!
    .count;
}

describe("POST /api/events", () => {
  test("stores a Mail package.detected event and queues it for routing", async () => {
    const response = await publish(packageEvent);

    expect(response.status).toBe(202);
    const { eventId } = (await response.json()) as { eventId: string };
    const event = getEvent(db, eventId);
    expect(event).toMatchObject({
      source: "mail",
      sourceEventId: "mail-message-1",
      type: "package.detected",
      payload: packageEvent.payload,
    });
    expect(listJobs(db, { queue: "delivery" })).toMatchObject([
      { type: "event.route", payload: { eventId }, eventId },
    ]);
  });

  test("routes the queued event to OmniApp through the delivery queue handler", async () => {
    const omni = createIntegration(db, {
      name: "OmniApp",
      kind: "omniapp",
      baseUrl: "https://omni.test",
      config: {},
    });
    createEventRoute(db, { eventType: "package.detected", integrationId: omni.id, config: {} });
    const sent: HttpRequest[] = [];
    const routing = createRoutingService({
      db,
      registry: createIntegrationRegistry({
        omniAppTransport: async (request) => {
          sent.push(request);
          return { status: 200, body: { id: "omni-package-1" } };
        },
      }),
    });

    const response = await publish(packageEvent);
    const { eventId } = (await response.json()) as { eventId: string };
    const job = claimJob<RouteEventJobPayload>(db, "test-worker", undefined, "delivery")!;
    await createDeliveryQueueHandler(db, routing)(job);

    expect(sent.map((request) => request.url)).toEqual(["https://omni.test/packages/detected"]);
    const delivery = db
      .query<{ id: string }, [string]>("SELECT id FROM deliveries WHERE event_id = ?")
      .get(eventId)!;
    expect(getDelivery(db, delivery.id)?.status).toBe("succeeded");
  });

  test("returns the original event for a duplicate sourceEventId", async () => {
    const first = (await (await publish(packageEvent)).json()) as { eventId: string };
    const response = await publish(packageEvent);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ eventId: first.eventId, duplicate: true });
    expect(eventCount()).toBe(1);
  });

  test("deduplicates by Idempotency-Key when there is no sourceEventId", async () => {
    const { sourceEventId: _, ...envelope } = packageEvent;
    const headers = { "idempotency-key": "retry-key-1" };
    const first = (await (await publish(envelope, "mail-token", headers)).json()) as {
      eventId: string;
    };
    const response = await publish(envelope, "mail-token", headers);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ eventId: first.eventId, duplicate: true });
  });

  test("rejects a missing or unknown token", async () => {
    expect((await publish(packageEvent, null)).status).toBe(401);
    expect((await publish(packageEvent, "wrong-token")).status).toBe(401);
    expect(eventCount()).toBe(0);
  });

  test("rejects a service without events:publish", async () => {
    const response = await publish({ ...packageEvent, source: "admin" }, "admin-token");
    expect(response.status).toBe(403);
    expect(eventCount()).toBe(0);
  });

  test("rejects a coding task request from a token without coding:request", async () => {
    const response = await publish({
      source: "mail",
      type: "coding.task.requested",
      payload: { project: "relay", prompt: "Fix the build." },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Service lacks the coding:request capability for coding.task.requested.",
    });
    expect(eventCount()).toBe(0);
    expect(listJobs(db)).toEqual([]);
  });

  test("accepts a coding task request from a token with coding:request", async () => {
    const response = await publish(
      { source: "omniapp", type: "coding.task.requested", payload: { prompt: "Fix the build." } },
      "omni-token"
    );
    expect(response.status).toBe(202);
  });

  test("rejects deploy requests without deploy:request", async () => {
    for (const type of ["deploy.requested", "git.merge.requested"]) {
      const response = await publish({ source: "omniapp", type, payload: {} }, "omni-token");
      expect(response.status).toBe(403);
    }
    expect(eventCount()).toBe(0);
  });

  test("rejects a service that publishes as another source", async () => {
    const response = await publish({ ...packageEvent, source: "omniapp" });
    expect(response.status).toBe(403);
    expect(eventCount()).toBe(0);
  });

  test("rejects an invalid envelope", async () => {
    for (const body of [
      "not json",
      { ...packageEvent, type: "package" },
      { ...packageEvent, payload: "text" },
      { type: "package.detected", payload: {} },
    ]) {
      expect((await publish(body)).status).toBe(400);
    }
    expect(eventCount()).toBe(0);
  });

  test("rejects a body larger than the configured limit", async () => {
    const response = await publish({ ...packageEvent, payload: { note: "x".repeat(600) } });
    expect(response.status).toBe(413);
    expect(eventCount()).toBe(0);
  });
});

describe("admin read APIs", () => {
  function read(load: AdminLoader, token: string | null = "admin-token", query = "") {
    const request = new Request(`http://relay.local/api/test${query}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return handleAdminRead(context, request, load);
  }

  test("require the admin:read capability", async () => {
    expect(read(loadEvents, null).status).toBe(401);
    expect(read(loadEvents, "wrong-token").status).toBe(401);
    expect(read(loadEvents, "mail-token").status).toBe(403);
  });

  test("return recent records and details", async () => {
    const older = createEvent(db, {
      source: "mail",
      type: "package.detected",
      payload: {},
      receivedAt: "2026-09-26T10:00:00.000Z",
    });
    const newer = createEvent(db, {
      source: "mail",
      type: "package.detected",
      payload: {},
      receivedAt: "2026-09-26T11:00:00.000Z",
    });
    const project = createProject(db, {
      name: "relay",
      path: "/srv/relay",
      defaultBranch: "main",
      executor: "codex",
      config: {},
    });
    const execution = createExecution(db, {
      projectId: project.id,
      executor: "codex",
      prompt: "Fix the build.",
    });

    const events = (await read(loadEvents).json()) as { events: { id: string }[] };
    expect(events.events.map((event) => event.id)).toEqual([newer.id, older.id]);
    const limited = (await read(loadEvents, "admin-token", "?limit=1").json()) as {
      events: unknown[];
    };
    expect(limited.events).toHaveLength(1);
    expect(read(loadEvents, "admin-token", "?limit=0").status).toBe(400);

    expect(await read(loadEvent(older.id)).json()).toMatchObject({
      event: { id: older.id },
      attempts: [],
      deliveries: [],
    });
    expect(read(loadEvent("missing")).status).toBe(404);
    expect(await read(loadAttempts).json()).toEqual({ attempts: [] });
    expect(await read(loadDeliveries).json()).toEqual({ deliveries: [] });
    expect(await read(loadExecutions).json()).toMatchObject({
      executions: [{ id: execution.id }],
    });
    expect(await read(loadExecution(execution.id)).json()).toMatchObject({
      execution: { id: execution.id },
      logs: [],
    });
    expect(await read(loadProjects).json()).toMatchObject({ projects: [{ id: project.id }] });
    expect(await read(loadProject(project.id)).json()).toMatchObject({
      project: { id: project.id },
    });
  });
});
