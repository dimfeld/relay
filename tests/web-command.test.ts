import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { getActivityFilterOptions, listActivity } from "../src/lib/server/activity";
import { createClassificationHandler } from "../src/lib/server/classifier/worker";
import { openDatabase } from "../src/lib/server/db";
import { createEvent } from "../src/lib/server/db/repositories/events";
import { getEventDetail } from "../src/lib/server/event-detail";
import {
  createIntegration,
  createEventRoute,
} from "../src/lib/server/db/repositories/integrations";
import { getJob } from "../src/lib/server/db/repositories/jobs";
import { createOperationalMetrics } from "../src/lib/server/logging/metrics";
import type { HttpRequest } from "../src/lib/server/integrations/types";
import { createIntegrationRegistry } from "../src/lib/server/integrations/registry";
import {
  createOnClassifiedCallback,
  createRoutingService,
} from "../src/lib/server/routing/service";
import { createClassificationWorker } from "../src/lib/server/queue/workers";
import { ingestPebbleWebhook } from "../src/lib/server/events/pebble";
import { ingestWebCommand } from "../src/lib/server/events/web";
import { fakeJev, fakeLuna } from "./classifier-fakes";

const databases: Database[] = [];

afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
});

function testDatabase(): Database {
  const db = openDatabase(":memory:");
  databases.push(db);
  return db;
}

function countRows(db: Database, table: "incoming_events" | "jobs"): number {
  return db.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`).get()!.count;
}

test("web command stores one web capture and one classification job", () => {
  const db = testDatabase();
  const metrics = createOperationalMetrics();
  const { eventId, duplicate } = ingestWebCommand(
    db,
    { text: "  Remind me to call Sam.  ", submissionId: "submission-1" },
    "correlation-1",
    () => {},
    metrics
  );
  const event = getEventDetail(db, eventId)?.event;
  const job = db
    .query<{ id: string }, [string]>("SELECT id FROM jobs WHERE event_id = ?")
    .get(eventId);

  expect(duplicate).toBe(false);
  expect(event).toMatchObject({
    source: "web",
    sourceEventId: "submission-1",
    type: "web.command",
    text: "Remind me to call Sam.",
    payload: { text: "Remind me to call Sam." },
    metadata: { correlationId: "correlation-1" },
  });
  const submittedAt = event!.metadata!.submittedAt;
  const recordedAt = event!.metadata!.recordedAt;
  if (typeof submittedAt !== "string" || typeof recordedAt !== "string") {
    throw new Error("Web capture timestamps must be strings.");
  }
  expect(recordedAt).toBe(submittedAt);
  expect(event!.receivedAt).toBe(submittedAt);
  expect(countRows(db, "incoming_events")).toBe(1);
  expect(countRows(db, "jobs")).toBe(1);
  expect(getJob(db, job!.id)).toMatchObject({
    type: "classify",
    queue: "classification",
    payload: { eventId },
    eventId,
    maxAttempts: 5,
  });
  expect(metrics.snapshot().incomingEvents).toBe(1);

  const activity = listActivity(db, { source: "web" });
  expect(activity).toHaveLength(1);
  expect(activity[0]).toMatchObject({ source: "web", summary: "Remind me to call Sam." });
  expect(getActivityFilterOptions(db).sources).toContain("web");
  expect(getEventDetail(db, eventId)?.normalizedEvent).toMatchObject({
    source: "web",
    type: "web.command",
    text: "Remind me to call Sam.",
  });
});

test("empty or non-text command input does not store an event or enqueue a job", () => {
  const db = testDatabase();
  const invalidInputs: unknown[] = [
    { text: "", submissionId: "empty" },
    { text: "  \n  ", submissionId: "whitespace" },
    { text: 42, submissionId: "number" },
    { text: null, submissionId: "null" },
    { text: "valid", submissionId: "  " },
  ];

  for (const input of invalidInputs) {
    expect(() => ingestWebCommand(db, input, "correlation-invalid", () => {})).toThrow(
      "Invalid command submission."
    );
  }

  expect(countRows(db, "incoming_events")).toBe(0);
  expect(countRows(db, "jobs")).toBe(0);
});

test("submission identity deduplicates retries and permits a later capture of the same text", () => {
  const db = testDatabase();
  const metrics = createOperationalMetrics();
  const first = ingestWebCommand(
    db,
    { text: "Call Sam", submissionId: "same-submission" },
    "correlation-1",
    () => {},
    metrics
  );
  const retry = ingestWebCommand(
    db,
    { text: "Call Sam", submissionId: "same-submission" },
    "correlation-retry",
    () => {},
    metrics
  );
  const later = ingestWebCommand(
    db,
    { text: "Call Sam", submissionId: "later-submission" },
    "correlation-2",
    () => {},
    metrics
  );

  expect(first.duplicate).toBe(false);
  expect(retry).toEqual({ eventId: first.eventId, duplicate: true });
  expect(later.duplicate).toBe(false);
  expect(later.eventId).not.toBe(first.eventId);
  expect(countRows(db, "incoming_events")).toBe(2);
  expect(countRows(db, "jobs")).toBe(2);
  expect(metrics.snapshot().incomingEvents).toBe(2);
});

test("ambiguous web commands remain visible for review and do not route", async () => {
  const db = testDatabase();
  const { eventId } = ingestWebCommand(
    db,
    { text: "Remind me to buy tea", submissionId: "ambiguous-submission" },
    "ambiguous-correlation",
    () => {}
  );
  let dispatched = false;
  const handler = createClassificationHandler({
    db,
    jev: fakeJev({
      coding_executor: "unspecified",
      reminder_time: "missing",
      action_type: "reminder",
    }),
    luna: fakeLuna({}),
    onClassified: () => {
      dispatched = true;
    },
  });
  await createClassificationWorker(db, handler, {
    pollIntervalMs: 1_000,
    staleAfterMs: 60_000,
  }).runOnce();

  const detail = getEventDetail(db, eventId)!;
  expect(dispatched).toBe(false);
  expect(detail.event.source).toBe("web");
  expect(detail.classifications[0].status).toBe("needs_review");
  expect(detail.attempts[0]).toMatchObject({
    stage: "classification",
    status: "needs_review",
  });
  expect(listActivity(db, { source: "web", status: "needs_review" })[0]).toMatchObject({
    id: eventId,
    highlight: true,
  });
  expect(countRows(db, "jobs")).toBe(1);
  expect(countRows(db, "incoming_events")).toBe(1);
});

function pebbleBody(recordedAtMs: number, transcription: string) {
  const boundary = "capture-equivalence-boundary";
  const fields = {
    client: "ring",
    recordedAt: String(recordedAtMs),
    transcription,
  };
  const body = `${Object.entries(fields)
    .map(
      ([name, value]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    )
    .join("")}--${boundary}--\r\n`;
  return { contentType: `multipart/form-data; boundary=${boundary}`, body };
}

function addPriorContextAndRoute(db: Database, referenceTime: string) {
  createEvent(db, {
    id: "prior-context",
    source: "web",
    type: "web.command",
    sourceEventId: "context-command",
    receivedAt: new Date(Date.parse(referenceTime) - 60_000).toISOString(),
    text: "The project is called Relay.",
    payload: { text: "The project is called Relay." },
  });
  const mail = createIntegration(db, {
    id: "mail",
    name: "Mail",
    kind: "mail",
    baseUrl: "https://mail.test",
    config: {},
  });
  createEventRoute(db, {
    id: "task-route",
    actionType: "task.create",
    integrationId: mail.id,
    config: {},
  });
}

test("web and Pebble captures classify and route the same text with equal time and context", async () => {
  const webDb = testDatabase();
  const pebbleDb = testDatabase();
  const text = "Tim, remind me to add buy tea to my task list.";
  const web = ingestWebCommand(
    webDb,
    { text, submissionId: "web-submission" },
    "web-correlation",
    () => {}
  );
  const webEvent = getEventDetail(webDb, web.eventId)!.event;
  const referenceTime = webEvent.metadata!.submittedAt as string;
  const { contentType, body } = pebbleBody(Date.parse(referenceTime), text);
  const pebble = await ingestPebbleWebhook(
    pebbleDb,
    contentType,
    new TextEncoder().encode(body),
    "pebble-correlation",
    () => {},
    createOperationalMetrics()
  );
  if ("error" in pebble) throw new Error(pebble.error);

  addPriorContextAndRoute(webDb, referenceTime);
  addPriorContextAndRoute(pebbleDb, referenceTime);

  const delivered: HttpRequest[][] = [[], []];
  const jevAdapters = [0, 1].map(() =>
    fakeJev({
      coding_executor: "unspecified",
      reminder_time: "missing",
      action_type: "task",
    })
  );
  const lunaAdapters = [0, 1].map(() =>
    fakeLuna({ type: "task.create", title: "Buy tea", notes: null, dueAt: null })
  );
  const handlers = [webDb, pebbleDb].map((db, index) => {
    const routing = createRoutingService({
      db,
      registry: createIntegrationRegistry({
        mailTransport: async (request) => {
          delivered[index].push(request);
          return { status: 201, body: { id: "mail-task-1" } };
        },
      }),
    });
    return createClassificationHandler({
      db,
      jev: jevAdapters[index],
      luna: lunaAdapters[index],
      wakeName: "Tim",
      onClassified: createOnClassifiedCallback(db, routing),
    });
  });

  await createClassificationWorker(webDb, handlers[0], {
    pollIntervalMs: 1_000,
    staleAfterMs: 60_000,
  }).runOnce();
  await createClassificationWorker(pebbleDb, handlers[1], {
    pollIntervalMs: 1_000,
    staleAfterMs: 60_000,
  }).runOnce();

  const webDetail = getEventDetail(webDb, web.eventId)!;
  const pebbleDetail = getEventDetail(pebbleDb, pebble.eventId)!;
  expect(webDetail.classifications[0].actionType).toBe("task.create");
  expect(pebbleDetail.classifications[0].actionType).toBe("task.create");
  expect((webDetail.classifications[0].result as { action: unknown }).action).toEqual(
    (pebbleDetail.classifications[0].result as { action: unknown }).action
  );
  expect(jevAdapters[0].requests).toEqual(jevAdapters[1].requests);
  expect(lunaAdapters[0].requests[0].prompt).toBe(lunaAdapters[1].requests[0].prompt);
  expect(lunaAdapters[0].requests[0].actionType).toBe(lunaAdapters[1].requests[0].actionType);
  expect(webDetail.contexts[0].items.map((item) => item.eventId)).toEqual(["prior-context"]);
  expect(pebbleDetail.contexts[0].items.map((item) => item.eventId)).toEqual(["prior-context"]);
  expect(delivered).toHaveLength(2);
  expect(delivered[0]).toHaveLength(1);
  expect(delivered[1]).toHaveLength(1);
  expect(JSON.parse(delivered[0][0].body)).toMatchObject({ title: "Buy tea", notes: null });
  expect(JSON.parse(delivered[1][0].body)).toMatchObject({ title: "Buy tea", notes: null });
  expect(webDetail.deliveries[0].delivery).toMatchObject({
    status: "succeeded",
    routeId: "task-route",
    response: { downstreamId: "mail-task-1" },
  });
  expect(pebbleDetail.deliveries[0].delivery).toMatchObject({
    status: "succeeded",
    routeId: "task-route",
    response: { downstreamId: "mail-task-1" },
  });
  expect(webDetail.actionResults[0].status).toBe("succeeded");
  expect(pebbleDetail.actionResults[0].status).toBe("succeeded");

  expect(listActivity(webDb, { source: "web" })[0]).toMatchObject({
    source: "web",
    summary: text,
    destination: "Mail",
    status: "succeeded",
  });
  expect(getEventDetail(webDb, web.eventId)?.normalizedEvent.source).toBe("web");
});
