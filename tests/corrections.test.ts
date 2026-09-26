import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { AdminActionError } from "../src/lib/server/admin-error";
import { handleAdminAction } from "../src/lib/server/api/admin";
import { createClassificationHandler } from "../src/lib/server/classifier/worker";
import { loadConfig } from "../src/lib/server/config";
import {
  correctClassification,
  readCorrectionInput,
  reclassifyEvent,
} from "../src/lib/server/corrections";
import { openDatabase } from "../src/lib/server/db";
import { listAttemptsForEvent } from "../src/lib/server/db/repositories/attempts";
import { listClassificationsForEvent } from "../src/lib/server/db/repositories/classifications";
import { createEvent, type IncomingEvent } from "../src/lib/server/db/repositories/events";
import {
  createEventRoute,
  createIntegration,
  type Integration,
} from "../src/lib/server/db/repositories/integrations";
import { enqueueJob, getJob } from "../src/lib/server/db/repositories/jobs";
import { getEventDetail } from "../src/lib/server/event-detail";
import { createIntegrationRegistry } from "../src/lib/server/integrations/registry";
import type { HttpRequest } from "../src/lib/server/integrations/types";
import { createTimCli } from "../src/lib/server/integrations/tim";
import { createProject } from "../src/lib/server/db/repositories/projects";
import { createLogger } from "../src/lib/server/logging";
import { createClassificationWorker } from "../src/lib/server/queue/workers";
import { createIdempotencyKey } from "../src/lib/server/routing/envelope";
import {
  createOnClassifiedCallback,
  createRoutingService,
  type RoutingService,
} from "../src/lib/server/routing/service";
import { fakeJev, fakeLuna } from "./classifier-fakes";

let db: Database;
let current: Date;
let mail: Integration;
let mailRequests: HttpRequest[];
let omniRequests: HttpRequest[];
let timCalls: Array<{ command: string; args: string[]; cwd: string }>;
let routing: RoutingService;
let event: IncomingEvent;
let classificationWorker: ReturnType<typeof createClassificationWorker>;

const noteAction = { type: "note.create", title: null, body: "Buy oat milk", topic: null };
const taskFields = { title: "Buy oat milk", notes: "", dueAt: "" };

beforeEach(async () => {
  db = openDatabase(":memory:");
  current = new Date("2026-09-26T12:00:00.000Z");
  mailRequests = [];
  omniRequests = [];
  timCalls = [];
  createProject(db, {
    id: "relay",
    name: "Relay",
    path: "/work/relay",
    defaultBranch: "main",
    executor: "codex",
    config: { aliases: ["relay-short"] },
  });

  mail = createIntegration(db, {
    name: "Mail",
    kind: "mail",
    baseUrl: "https://mail.test",
    config: {},
  });
  createEventRoute(db, { actionType: "task.create", integrationId: mail.id, config: {} });
  const omni = createIntegration(db, {
    name: "OmniApp",
    kind: "omniapp",
    baseUrl: "https://omni.test",
    config: {},
  });
  createEventRoute(db, { actionType: "note.create", integrationId: omni.id, config: {} });

  routing = createRoutingService({
    db,
    registry: createIntegrationRegistry({
      mailTransport: async (request) => {
        mailRequests.push(request);
        return { status: 201, body: { id: `task-${mailRequests.length}` } };
      },
      omniAppTransport: async (request) => {
        omniRequests.push(request);
        return { status: 201, body: { id: `note-${omniRequests.length}` } };
      },
    }),
    timCli: createTimCli({
      process: async (command, args, { cwd }) => {
        timCalls.push({ command, args, cwd });
        return { exitCode: 0, stdout: "Created plan stub: plan 71", stderr: "" };
      },
    }),
    log: createLogger(() => {}),
  });

  event = createEvent(db, {
    id: "capture-1",
    source: "pebble",
    type: "pebble.transcription",
    payload: {},
    text: "Buy oat milk",
  });
  enqueueJob(db, {
    type: "classify",
    queue: "classification",
    payload: { eventId: event.id },
    eventId: event.id,
    maxAttempts: 1,
    availableAt: current.toISOString(),
  });
  const handler = createClassificationHandler({
    db,
    jev: fakeJev({
      action_type: "new_note",
      coding_executor: "unspecified",
      reminder_time: "missing",
    }),
    luna: fakeLuna(noteAction),
    onClassified: createOnClassifiedCallback(db, routing),
  });
  classificationWorker = createClassificationWorker(db, handler, {
    pollIntervalMs: 1_000,
    staleAfterMs: 60_000,
    now: () => current,
  });
  await classificationWorker.runOnce();
});

afterEach(() => {
  db.close();
});

function correctToTask(attemptId = "correction-1", fields: Record<string, string> = taskFields) {
  return correctClassification(
    db,
    routing,
    event.id,
    { attemptId, actionType: "task.create", fields },
    "operator"
  );
}

describe("corrections", () => {
  test("correct a note to a task, dispatch it to Mail once, and keep the original", async () => {
    expect(omniRequests).toHaveLength(1);
    const [original] = listClassificationsForEvent(db, event.id);
    expect(original).toMatchObject({ actionType: "note.create", provider: "fake-typesafe" });

    const result = await correctToTask();
    expect(result).toMatchObject({
      duplicate: false,
      attempt: { id: "correction-1", stage: "correction", status: "succeeded" },
      classification: {
        actionType: "task.create",
        provider: "operator",
        status: "classified",
        result: {
          attemptId: "correction-1",
          action: { type: "task.create", title: "Buy oat milk", notes: null, dueAt: null },
          correction: { correctedBy: "operator", correctsClassificationId: original.id },
        },
      },
    });

    expect(mailRequests).toHaveLength(1);
    expect(mailRequests[0].url).toBe("https://mail.test/tasks");
    expect(mailRequests[0].headers["Idempotency-Key"]).toBe(
      createIdempotencyKey(event.id, "task.create", mail.id, "correction-1")
    );
    expect(JSON.parse(mailRequests[0].body)).toEqual({
      title: "Buy oat milk",
      notes: null,
      dueAt: null,
      sourceEventId: event.id,
    });

    // A double click submits the same attempt ID again.
    const repeat = await correctToTask();
    expect(repeat.duplicate).toBe(true);
    expect(repeat.classification.id).toBe(result.classification.id);
    expect(mailRequests).toHaveLength(1);
    expect(omniRequests).toHaveLength(1);

    const detail = getEventDetail(db, event.id)!;
    expect(detail.classifications).toEqual([original, result.classification]);
    expect(detail.classifications[0].result).toMatchObject({ action: noteAction });
    expect(detail.attempts.map((attempt) => [attempt.stage, attempt.status])).toEqual([
      ["classification", "succeeded"],
      ["correction", "succeeded"],
    ]);

    const taskDelivery = detail.deliveries.find((d) => d.delivery.integrationId === mail.id)!;
    expect(detail.corrections).toEqual([
      {
        attemptId: "correction-1",
        status: "succeeded",
        error: null,
        correctedAt: expect.any(String),
        correctedBy: "operator",
        correctsClassificationId: original.id,
        classificationId: result.classification.id,
        deliveryId: taskDelivery.delivery.id,
      },
    ]);
    expect(detail.deliveries.map((d) => [d.delivery.status, d.correctionAttemptId])).toEqual([
      ["succeeded", null],
      ["succeeded", "correction-1"],
    ]);
    expect(taskDelivery.downstreamId).toBe("task-1");
    expect(detail.actionResults.map((r) => [r.actionType, r.status])).toEqual([
      ["note.create", "succeeded"],
      ["task.create", "succeeded"],
    ]);
    expect(detail.failedStep).toBeNull();
  });

  test("a second correction is a new attempt with a new idempotency key", async () => {
    await correctToTask("correction-1");
    await correctToTask("correction-2", { ...taskFields, title: "Buy oat milk and bread" });

    expect(mailRequests.map((request) => request.headers["Idempotency-Key"])).toEqual([
      createIdempotencyKey(event.id, "task.create", mail.id, "correction-1"),
      createIdempotencyKey(event.id, "task.create", mail.id, "correction-2"),
    ]);
    const corrections = getEventDetail(db, event.id)!.corrections;
    expect(corrections[1].correctsClassificationId).toBe(corrections[0].classificationId);
  });

  test("corrects to a Tim plan action and preserves its description", async () => {
    const description = "--help me\nKeep this text.";
    const result = await correctClassification(
      db,
      routing,
      event.id,
      {
        attemptId: "tim-correction",
        actionType: "tim.plan.create_and_execute",
        fields: { project: "relay-short", description },
      },
      "operator"
    );

    expect(result).toMatchObject({
      attempt: { status: "succeeded" },
      classification: {
        actionType: "tim.plan.create_and_execute",
        result: { action: { projectId: "relay", projectName: "Relay", description } },
      },
    });
    expect(timCalls).toEqual([
      {
        command: "tim",
        args: [
          "add",
          "--simple",
          "--status",
          "queued",
          `--details=${description}`,
          "--",
          description,
        ],
        cwd: "/work/relay",
      },
    ]);
    expect(getEventDetail(db, event.id)!.actionResults.at(-1)).toMatchObject({
      actionType: "tim.plan.create_and_execute",
      status: "succeeded",
      result: { timPlanId: "71", queueMode: "queued" },
    });
  });

  test("rejects Tim corrections with an unknown project or empty description", async () => {
    const makeTimCorrection = (attemptId: string, project: string, description: string) =>
      correctClassification(
        db,
        routing,
        event.id,
        {
          attemptId,
          actionType: "tim.plan.create",
          fields: { project, description },
        },
        "operator"
      );

    await expect(
      makeTimCorrection("unknown-project", "missing", "Create a plan.")
    ).rejects.toMatchObject({
      status: 400,
      message: "Enter a registered project name or alias.",
    });
    await expect(makeTimCorrection("empty-description", "relay-short", "  ")).rejects.toMatchObject(
      {
        status: 400,
        message: "Enter a value for: Plan description.",
      }
    );
    expect(timCalls).toEqual([]);
  });

  test("reject invalid replacement fields without recording or dispatching", async () => {
    await expect(correctToTask("bad-1", { title: "  " })).rejects.toEqual(
      new AdminActionError(400, "Enter a value for: Title.")
    );
    const invalidDate = correctToTask("bad-2", { title: "Buy oat milk", dueAt: "tomorrow" });
    await expect(invalidDate).rejects.toThrow(/dueAt/);
    await expect(invalidDate).rejects.toMatchObject({ status: 400 });

    expect(() =>
      readCorrectionInput({ attemptId: "bad-3", actionType: "command.execute", fields: {} })
    ).toThrow(AdminActionError);

    expect(mailRequests).toHaveLength(0);
    expect(listClassificationsForEvent(db, event.id)).toHaveLength(1);
    expect(listAttemptsForEvent(db, event.id).map((attempt) => attempt.stage)).toEqual([
      "classification",
    ]);
  });

  test("reclassify runs the classifier again and appends a new attempt", async () => {
    const job = reclassifyEvent(db, event.id, "operator", current.toISOString());
    expect(job.payload).toEqual({
      eventId: event.id,
      reclassification: { requestedBy: "operator" },
    });
    expect(() => reclassifyEvent(db, event.id, "operator")).toThrow(
      new AdminActionError(409, `Event ${event.id} is already waiting for classification.`)
    );
    expect(() => reclassifyEvent(db, "missing", "operator")).toThrow(
      new AdminActionError(404, "Event missing does not exist.")
    );

    await classificationWorker.runOnce();

    expect(getJob(db, job.id)?.status).toBe("succeeded");
    const attempts = listAttemptsForEvent(db, event.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].details).not.toHaveProperty("reclassification");
    expect(attempts[1]).toMatchObject({
      stage: "classification",
      status: "succeeded",
      details: { jobId: job.id, reclassification: { requestedBy: "operator" } },
    });
    expect(listClassificationsForEvent(db, event.id).map((c) => c.actionType)).toEqual([
      "note.create",
      "note.create",
    ]);
    // The same note has the same stable idempotency key, so it is not sent again.
    expect(omniRequests).toHaveLength(1);
  });
});

describe("correction APIs", () => {
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

  function post(token: string, body: unknown) {
    const request = new Request("http://relay.local/api/events/capture-1/corrections", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return handleAdminAction(context(), request, async (db, identity) =>
      correctClassification(
        db,
        routing,
        event.id,
        readCorrectionInput(await request.json()),
        identity.name
      )
    );
  }

  test("corrections need admin:retry and record the calling service", async () => {
    const body = { attemptId: "api-correction", actionType: "task.create", fields: taskFields };

    expect((await post("reader-token", body)).status).toBe(403);
    expect(mailRequests).toHaveLength(0);

    const invalid = await post("operator-token", { ...body, fields: { title: "" } });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "Enter a value for: Title." });

    const accepted = await post("operator-token", body);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      duplicate: false,
      classification: { result: { correction: { correctedBy: "operator" } } },
    });
    expect(mailRequests).toHaveLength(1);
  });
});
