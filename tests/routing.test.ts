import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createEvent } from "../src/lib/server/db/repositories/events";
import {
  createEventRoute,
  createIntegration,
  updateEventRoute,
} from "../src/lib/server/db/repositories/integrations";
import { findDeliveryByIdempotencyKey } from "../src/lib/server/db/repositories/deliveries";
import { openDatabase } from "../src/lib/server/db";
import { createIntegrationRegistry } from "../src/lib/server/integrations/registry";
import type { HttpRequest, HttpTransport } from "../src/lib/server/integrations/types";
import { createDeliveryEnvelope } from "../src/lib/server/routing/envelope";
import { createRoutingService } from "../src/lib/server/routing/service";

let db: Database;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function makeEvent(
  id: string,
  type: string,
  payload: unknown,
  metadata: Record<string, unknown> | null = null
) {
  return createEvent(db, {
    id,
    source: "test",
    type,
    payload,
    metadata,
  });
}

function makeIntegration(name: string, kind: string, baseUrl: string) {
  return createIntegration(db, { name, kind, baseUrl, config: {} });
}

function makeRoute(
  integrationId: string,
  match: { eventType?: string; actionType?: string },
  id?: string
) {
  return createEventRoute(db, { id, ...match, integrationId, config: {} });
}

function requestBody(request: HttpRequest): Record<string, unknown> {
  return JSON.parse(request.body) as Record<string, unknown>;
}

describe("routing and owner adapters", () => {
  test("routes task capture to Mail and stores its returned ID after the pending row exists", async () => {
    const mail = makeIntegration("Mail", "mail", "https://mail.test/api");
    const event = makeEvent(
      "event-task",
      "pebble.transcription",
      { text: "Buy tea" },
      {
        correlationId: "correlation-task",
      }
    );
    makeRoute(mail.id, { actionType: "task.create" });
    let request: HttpRequest | undefined;
    const mailTransport: HttpTransport = async (sent) => {
      request = sent;
      const pending = findDeliveryByIdempotencyKey(db, sent.headers["Idempotency-Key"]);
      expect(pending).toMatchObject({
        eventId: event.id,
        integrationId: mail.id,
        status: "pending",
      });
      return { status: 201, body: { id: "mail-task-42" } };
    };
    const service = createRoutingService({
      db,
      registry: createIntegrationRegistry({ mailTransport }),
    });

    const outcome = await service.routeAction(event, {
      type: "task.create",
      title: "Buy tea",
      notes: null,
      dueAt: null,
    });

    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") return;
    expect(outcome.delivery).toMatchObject({
      status: "succeeded",
      routeId: expect.any(String),
      response: {
        status: 201,
        body: { id: "mail-task-42" },
        bodyTruncated: false,
        downstreamId: "mail-task-42",
      },
    });
    expect(outcome.actionResult).not.toBeNull();
    expect(outcome.actionResult?.result).toMatchObject({
      integrationId: mail.id,
      integrationName: mail.name,
      routeId: outcome.delivery.routeId,
      downstreamId: "mail-task-42",
    });
    expect(request?.url).toBe("https://mail.test/api/tasks");
    expect(request?.headers["X-Correlation-ID"]).toBe("correlation-task");
    expect(requestBody(request!)).toEqual({
      title: "Buy tea",
      notes: null,
      dueAt: null,
      sourceEventId: event.id,
    });
  });

  test("sends Mail reminders with the owner fields and records the Mail reminder ID", async () => {
    const mail = makeIntegration("Mail reminders", "mail", "https://mail.test");
    const event = makeEvent("event-reminder", "pebble.transcription", {});
    makeRoute(mail.id, { actionType: "reminder.create" });
    const requests: HttpRequest[] = [];
    const service = createRoutingService({
      db,
      registry: createIntegrationRegistry({
        mailTransport: async (sent) => {
          requests.push(sent);
          return { status: 201, body: { id: "mail-reminder-8" } };
        },
      }),
    });
    const action = {
      type: "reminder.create" as const,
      text: "Take medicine",
      remindAt: "2026-09-27T08:00:00Z",
      timeZone: "Etc/UTC",
      originalTimePhrase: "tomorrow morning",
    };

    const outcome = await service.routeAction(event, action);
    const repeated = await service.routeAction(event, action);

    expect(outcome.status).toBe("succeeded");
    expect(repeated.status).toBe("succeeded");
    if (outcome.status !== "succeeded" || repeated.status !== "succeeded") return;
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe("https://mail.test/reminders");
    expect(request.headers["Idempotency-Key"]).toBe(outcome.delivery.idempotencyKey);
    expect(repeated.delivery.idempotencyKey).toBe(outcome.delivery.idempotencyKey);
    expect(requestBody(request)).toEqual({
      text: "Take medicine",
      remindAt: "2026-09-27T08:00:00Z",
      timeZone: "Etc/UTC",
      originalTimePhrase: "tomorrow morning",
      sourceEventId: event.id,
    });
    expect(outcome.delivery.response?.downstreamId).toBe("mail-reminder-8");
    expect(outcome.actionResult?.result).toMatchObject({
      integrationId: mail.id,
      downstreamId: "mail-reminder-8",
    });
  });

  test("routes a structured package.detected event to OmniApp", async () => {
    const omni = makeIntegration("OmniApp", "omniapp", "https://omni.test/v1");
    const event = makeEvent("mail-package-17", "package.detected", {
      trackingNumber: "TRACK-17",
      carrier: "Parcel Post",
    });
    makeRoute(omni.id, { eventType: "package.detected" });
    let request: HttpRequest | undefined;
    const service = createRoutingService({
      db,
      registry: createIntegrationRegistry({
        omniAppTransport: async (sent) => {
          request = sent;
          return { status: 200, body: { id: "omni-package-17" } };
        },
      }),
    });

    const outcome = await service.routeEvent(event);

    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") return;
    expect(outcome.delivery.response?.downstreamId).toBe("omni-package-17");
    expect(request?.url).toBe("https://omni.test/v1/packages/detected");
    expect(requestBody(request!)).toEqual({
      trackingNumber: "TRACK-17",
      carrier: "Parcel Post",
      sourceEventId: event.id,
    });
  });

  test("sends optional note actions to OmniApp", async () => {
    const omni = makeIntegration("OmniApp notes", "omniapp", "https://omni.test");
    makeRoute(omni.id, { actionType: "note.create" });
    makeRoute(omni.id, { actionType: "note.append" });
    const requests: HttpRequest[] = [];
    const service = createRoutingService({
      db,
      registry: createIntegrationRegistry({
        omniAppTransport: async (request) => {
          requests.push(request);
          return { status: 200, body: { id: `omni-note-${requests.length}` } };
        },
      }),
    });

    await service.routeAction(makeEvent("note-create", "pebble.transcription", {}), {
      type: "note.create",
      title: "Garden",
      body: "Plant basil",
      topic: "garden",
    });
    await service.routeAction(makeEvent("note-append", "pebble.transcription", {}), {
      type: "note.append",
      body: "Use the south bed",
      targetId: "omni-note-1",
      contextEventId: "note-create",
    });

    expect(requests.map((request) => request.url)).toEqual([
      "https://omni.test/notes",
      "https://omni.test/notes/append",
    ]);
    expect(requestBody(requests[0]!)).toMatchObject({
      title: "Garden",
      body: "Plant basil",
      topic: "garden",
      sourceEventId: "note-create",
    });
    expect(requestBody(requests[1]!)).toMatchObject({
      body: "Use the south bed",
      targetId: "omni-note-1",
      contextEventId: "note-create",
      sourceEventId: "note-append",
    });
  });

  test("uses the same key for repeated delivery and skips the adapter after success", async () => {
    const mail = makeIntegration("Mail idempotency", "mail", "https://mail.test");
    const event = makeEvent("event-idempotent", "pebble.transcription", {});
    makeRoute(mail.id, { actionType: "task.create" });
    let calls = 0;
    const service = createRoutingService({
      db,
      registry: createIntegrationRegistry({
        mailTransport: async () => {
          calls += 1;
          return { status: 201, body: { id: "mail-task-once" } };
        },
      }),
    });
    const action = { type: "task.create" as const, title: "Read", notes: null, dueAt: null };

    const first = await service.routeAction(event, action);
    const second = await service.routeAction(event, action);

    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    if (first.status !== "succeeded" || second.status !== "succeeded") return;
    expect(first.delivery.idempotencyKey).toBe(second.delivery.idempotencyKey);
    expect(second.delivery.id).toBe(first.delivery.id);
    expect(second.actionResult).toBeNull();
    expect(calls).toBe(1);
  });

  test("prefers a route matching both event and action over an action-only route", async () => {
    const broadMail = makeIntegration("Broad Mail", "mail", "https://broad.test");
    const exactMail = makeIntegration("Exact Mail", "mail", "https://exact.test");
    const event = makeEvent("event-precedence", "pebble.transcription", {});
    makeRoute(broadMail.id, { actionType: "task.create" }, "broad-route");
    const exactRoute = makeRoute(
      exactMail.id,
      { eventType: "pebble.transcription", actionType: "task.create" },
      "exact-route"
    );
    let url = "";
    const service = createRoutingService({
      db,
      registry: createIntegrationRegistry({
        mailTransport: async (request) => {
          url = request.url;
          return { status: 201, body: { id: "exact-task" } };
        },
      }),
    });

    const outcome = await service.routeAction(event, {
      type: "task.create",
      title: "Exact route",
      notes: null,
      dueAt: null,
    });

    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") return;
    expect(outcome.delivery.routeId).toBe(exactRoute.id);
    expect(url).toBe("https://exact.test/tasks");
  });

  test("a route change sends the next event to the new configured integration", async () => {
    const firstMail = makeIntegration("First Mail", "mail", "https://first.test");
    const secondMail = makeIntegration("Second Mail", "mail", "https://second.test");
    const event = makeEvent("event-route-change", "pebble.transcription", {});
    const route = makeRoute(firstMail.id, { actionType: "task.create" });
    const requests: HttpRequest[] = [];
    const service = createRoutingService({
      db,
      registry: createIntegrationRegistry({
        mailTransport: async (request) => {
          requests.push(request);
          return { status: 201, body: { id: `task-${requests.length}` } };
        },
      }),
    });
    const action = {
      type: "task.create" as const,
      title: "Same capture",
      notes: null,
      dueAt: null,
    };

    const first = await service.routeAction(event, action);
    updateEventRoute(db, route.id, { integrationId: secondMail.id });
    const second = await service.routeAction(event, action);

    expect(requests.map((request) => request.url)).toEqual([
      "https://first.test/tasks",
      "https://second.test/tasks",
    ]);
    expect(requests[0]?.headers["Idempotency-Key"]).not.toBe(
      requests[1]?.headers["Idempotency-Key"]
    );
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
  });

  test("records unrouted results for missing and disabled integrations without deliveries", async () => {
    const event = makeEvent("event-unrouted", "pebble.transcription", {});
    const mail = makeIntegration("Disabled Mail", "mail", "https://mail.test");
    const service = createRoutingService({ db });
    const action = { type: "task.create" as const, title: "No owner", notes: null, dueAt: null };

    const missing = await service.routeAction(event, action);
    makeRoute(mail.id, { actionType: "task.create" }, "disabled-integration-route");
    db.query("UPDATE integrations SET enabled = 0 WHERE id = ?").run(mail.id);
    const disabled = await service.routeAction(event, action);

    expect(missing.status).toBe("unrouted");
    expect(disabled.status).toBe("unrouted");
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM deliveries").get()?.count
    ).toBe(0);
    expect(
      db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM action_results").get()?.count
    ).toBe(2);
  });

  test("schedules a retry for a transient non-2xx response", async () => {
    const mail = makeIntegration("Failing Mail", "mail", "https://mail.test");
    const event = makeEvent("event-failure", "pebble.transcription", {});
    makeRoute(mail.id, { actionType: "task.create" });
    const service = createRoutingService({
      db,
      registry: createIntegrationRegistry({
        mailTransport: async () => ({ status: 503, body: { message: "unavailable" } }),
      }),
      log: () => {},
    });

    const outcome = await service.routeAction(event, {
      type: "task.create",
      title: "Try later",
      notes: null,
      dueAt: null,
    });

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.delivery).toMatchObject({
      status: "failed",
      attempts: 1,
      nextAttemptAt: expect.any(String),
      lastError: expect.stringContaining("HTTP 503"),
      response: { status: 503, body: { message: "unavailable" } },
    });
    expect(outcome.actionResult).toBeNull();
  });

  test("marks a successful HTTP response without an object ID as dead", async () => {
    const mail = makeIntegration("Mail without ID", "mail", "https://mail.test");
    const event = makeEvent("event-missing-id", "pebble.transcription", {});
    makeRoute(mail.id, { actionType: "task.create" });
    const service = createRoutingService({
      db,
      registry: createIntegrationRegistry({
        mailTransport: async () => ({ status: 201, body: { accepted: true } }),
      }),
      log: () => {},
    });

    const outcome = await service.routeAction(event, {
      type: "task.create",
      title: "Need an ID",
      notes: null,
      dueAt: null,
    });

    expect(outcome.status).toBe("dead");
    if (outcome.status !== "dead") return;
    expect(outcome.delivery.lastError).toContain("did not include an object id");
    expect(outcome.actionResult?.status).toBe("failed");
  });

  test("falls back to the event ID when an event has no correlation ID", () => {
    const event = makeEvent("event-correlation-fallback", "package.detected", {});

    const envelope = createDeliveryEnvelope(event, "package.detected", "omni", event.payload);

    expect(envelope.correlationId).toBe(event.id);
    expect(envelope.idempotencyKey).toBe(
      createDeliveryEnvelope(event, "package.detected", "omni", event.payload).idempotencyKey
    );
  });
});
