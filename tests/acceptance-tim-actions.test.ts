import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { classifyCapture } from "../src/lib/server/classifier/service";
import { createClassificationHandler } from "../src/lib/server/classifier/worker";
import { loadConfig } from "../src/lib/server/config";
import type { ServerContext } from "../src/lib/server/context";
import { openDatabase } from "../src/lib/server/db";
import { createProject } from "../src/lib/server/db/repositories/projects";
import { createEvent } from "../src/lib/server/db/repositories/events";
import {
  createActionResult,
  listActionResultsForEvent,
} from "../src/lib/server/db/repositories/actionResults";
import { claimJob, enqueueJob, getJob } from "../src/lib/server/db/repositories/jobs";
import { getEventDetail } from "../src/lib/server/event-detail";
import { handlePublishEvent } from "../src/lib/server/api/events";
import { createTimCli, parseTimPlanId, type TimProcess } from "../src/lib/server/integrations/tim";
import { fakeJev, fakeLuna } from "./classifier-fakes";
import {
  createDeliveryQueueHandler,
  createOnClassifiedCallback,
  createRoutingService,
  type RouteEventJobPayload,
} from "../src/lib/server/routing/service";
import { createClassificationWorker, createDeliveryWorker } from "../src/lib/server/queue/workers";

const project = {
  id: "relay",
  name: "Relay",
  alias: "relay-short",
  directory: "/work/relay",
};
const recordedAt = "2026-09-26T12:00:00.000Z";

let db: Database;

beforeEach(() => {
  db = openDatabase(":memory:");
  createProject(db, {
    id: project.id,
    name: project.name,
    path: project.directory,
    defaultBranch: "main",
    executor: "codex",
    config: { aliases: [project.alias] },
  });
});

afterEach(() => {
  db.close();
});

function makeEvent(id: string, text = "Create a Tim plan") {
  return createEvent(db, {
    id,
    source: "pebble",
    type: "pebble.transcription",
    payload: { text },
    text,
    metadata: { recordedAt },
  });
}

function requestContext(): ServerContext {
  return {
    db,
    config: loadConfig({
      PUBLIC_PORT: "4310",
      INTERNAL_PORT: "4311",
      DATABASE_PATH: ":memory:",
      PEBBLE_WEBHOOK_SECRETS: "secret",
      INTERNAL_SERVICE_CREDENTIALS: JSON.stringify({
        tim: { token: "tim-token", capabilities: ["events:publish", "tim:plan"] },
      }),
      DEFAULT_EXECUTOR: "codex",
      CODEX_EXECUTABLE: "codex",
      CLAUDE_EXECUTABLE: "claude",
    }),
  };
}

function fakeProcess(calls: Array<{ command: string; args: string[]; cwd: string }>): TimProcess {
  return async (command, args, { cwd }) => {
    calls.push({ command, args, cwd });
    return {
      exitCode: 0,
      stdout: `✓ Created plan stub: plan ${40 + calls.length}\n`,
      stderr: "",
    };
  };
}

describe("Tim plan action acceptance", () => {
  test("parses the plan ID from Tim's colored add output", () => {
    expect(parseTimPlanId("\u001b[32m✓ Created plan stub:\u001b[39m plan 42\n")).toBe("42");
  });

  test("classifies both labels, resolves the project alias, and records exact Tim commands", async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const timCli = createTimCli({ process: fakeProcess(calls) });
    const routing = createRoutingService({ db, timCli });
    const cases = [
      {
        label: "tim_plan_create",
        type: "tim.plan.create" as const,
        description: "--help me\nPreserve this complete description.",
      },
      {
        label: "tim_plan_create_and_execute",
        type: "tim.plan.create_and_execute" as const,
        description: "Add an acceptance test and queue it.",
      },
    ];

    for (const [index, item] of cases.entries()) {
      const event = makeEvent(`capture-${index + 1}`, item.description);
      enqueueJob(db, {
        type: "classify",
        queue: "classification",
        payload: { eventId: event.id },
        eventId: event.id,
        maxAttempts: 1,
        availableAt: recordedAt,
      });
      const jev = fakeJev({
        action_type: item.label,
        coding_executor: "unspecified",
        reminder_time: "missing",
      });
      const handler = createClassificationHandler({
        db,
        jev,
        luna: fakeLuna({
          type: item.type,
          project: project.alias,
          description: item.description,
        }),
        onClassified: createOnClassifiedCallback(db, routing),
      });
      const worker = createClassificationWorker(db, handler, {
        pollIntervalMs: 1_000,
        staleAfterMs: 60_000,
        now: () => new Date(recordedAt),
      });
      expect(await worker.runOnce()).toBe(true);

      expect(jev.requests[0]?.questions.action_type).toMatchObject({
        type: "choice",
        options: { [item.label]: expect.any(String) },
      });
      const classification = getEventDetail(db, event.id)!.classifications[0]!;
      expect(classification.result).toMatchObject({
        action: {
          type: item.type,
          projectId: project.id,
          projectName: project.name,
          description: item.description,
        },
      });
      expect(listActionResultsForEvent(db, event.id)[0]).toMatchObject({
        actionType: item.type,
        status: "succeeded",
        result: {
          projectId: project.id,
          timPlanId: String(41 + index),
          queueMode: index === 0 ? "default" : "queued",
          commandOutcome: { state: "succeeded", exitCode: 0 },
        },
      });
    }

    expect(calls).toEqual([
      {
        command: "tim",
        args: [
          "add",
          "--details=--help me\nPreserve this complete description.",
          "--",
          "--help me\nPreserve this complete description.",
        ],
        cwd: project.directory,
      },
      {
        command: "tim",
        args: [
          "add",
          "--simple",
          "--status",
          "queued",
          "--details=Add an acceptance test and queue it.",
          "--",
          "Add an acceptance test and queue it.",
        ],
        cwd: project.directory,
      },
    ]);
  });

  test("routes an authorized internal queued request and exposes its result in event detail", async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const routing = createRoutingService({
      db,
      timCli: createTimCli({ process: fakeProcess(calls) }),
    });
    const context = requestContext();
    const response = await handlePublishEvent(
      context,
      new Request("http://relay.local/api/events", {
        method: "POST",
        headers: {
          authorization: "Bearer tim-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          source: "tim",
          type: "tim.plan.create_and_execute.requested",
          sourceEventId: "tim-plan-1",
          payload: { project: project.alias, description: "Queue a small Relay task." },
        }),
      }),
      "correlation-tim-plan"
    );
    expect(response.status).toBe(202);
    const { eventId } = (await response.json()) as { eventId: string };
    const job = claimJob<RouteEventJobPayload>(db, "delivery-worker", undefined, "delivery")!;
    await createDeliveryQueueHandler(db, routing)(job);

    expect(calls).toHaveLength(1);
    expect(getEventDetail(db, eventId)!.actionResults[0]).toMatchObject({
      actionType: "tim.plan.create_and_execute",
      status: "succeeded",
      result: {
        projectId: project.id,
        timPlanId: "41",
        queueMode: "queued",
      },
    });
  });

  test("needs review for an absent or unknown project and an empty description", async () => {
    const common = {
      text: "Create a Tim plan",
      referenceTime: recordedAt,
      projects: [{ id: project.id, name: project.name, aliases: [project.alias] }],
      context: [],
    };
    for (const projectName of [null, "missing-project"]) {
      const result = await classifyCapture(common, {
        jev: fakeJev({ action_type: "tim_plan_create", coding_executor: "unspecified" }),
        luna: fakeLuna({
          type: "tim.plan.create",
          project: projectName,
          description: "Make a useful plan.",
        }),
      });
      expect(result).toMatchObject({
        status: "needs_review",
        actionType: "tim.plan.create",
        record: { reason: "Tim plan request does not name a registered project" },
      });
    }

    const emptyDescription = await classifyCapture(common, {
      jev: fakeJev({ action_type: "tim_plan_create", coding_executor: "unspecified" }),
      luna: fakeLuna({ type: "tim.plan.create", project: project.alias, description: "" }),
    });
    expect(emptyDescription).toMatchObject({
      status: "needs_review",
      actionType: "tim.plan.create",
    });

    const extraFields = await classifyCapture(common, {
      jev: fakeJev({ action_type: "tim_plan_create", coding_executor: "unspecified" }),
      luna: fakeLuna({
        type: "tim.plan.create",
        project: project.alias,
        description: "Make a plan.",
        executable: "tim",
      }),
    });
    expect(extraFields.status).toBe("needs_review");
  });

  test("keeps clean process failures and allows the durable retry to create a plan", async () => {
    const event = createEvent(db, {
      id: "process-failure",
      source: "tim",
      type: "tim.plan.create.requested",
      payload: { project: project.alias, description: "Create a plan after a clean failure." },
    });
    const job = enqueueJob<RouteEventJobPayload>(db, {
      type: "event.route",
      queue: "delivery",
      payload: { eventId: event.id },
      eventId: event.id,
      maxAttempts: 2,
      availableAt: recordedAt,
    });
    let calls = 0;
    const timCli = createTimCli({
      process: async () => {
        calls += 1;
        return calls === 1
          ? { exitCode: 2, stdout: "", stderr: "Tim could not write the plan." }
          : { exitCode: 0, stdout: "Created plan stub: plan 88", stderr: "" };
      },
    });
    const routing = createRoutingService({ db, timCli });
    const worker = createDeliveryWorker(db, createDeliveryQueueHandler(db, routing), {
      pollIntervalMs: 1_000,
      staleAfterMs: 60_000,
      now: () => new Date(recordedAt),
      backoff: () => 0,
    });
    expect(await worker.runOnce()).toBe(true);
    expect(listActionResultsForEvent(db, event.id)[0]).toMatchObject({
      status: "failed",
      result: {
        commandOutcome: {
          state: "failed",
          exitCode: 2,
          stderr: "Tim could not write the plan.",
        },
      },
    });
    expect(getJob(db, job.id)?.status).toBe("pending");
    expect(await worker.runOnce()).toBe(true);
    expect(calls).toBe(2);
    expect(getJob(db, job.id)?.status).toBe("succeeded");
    expect(listActionResultsForEvent(db, event.id).map((result) => result.status)).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(listActionResultsForEvent(db, event.id)[1]).toMatchObject({
      result: { timPlanId: "88", queueMode: "default" },
    });
  });

  test("does not repeat an uncertain Tim command or a successful duplicate", async () => {
    const event = makeEvent("uncertain-process");
    let calls = 0;
    const routing = createRoutingService({
      db,
      timCli: createTimCli({
        process: async () => {
          calls += 1;
          throw new Error("process interrupted");
        },
      }),
    });
    const action = {
      type: "tim.plan.create_and_execute" as const,
      projectId: project.id,
      projectName: project.name,
      description: "Queue this plan once.",
    };

    const first = await routing.routeAction(event, action);
    const second = await routing.routeAction(event, action);
    expect(first).toMatchObject({ status: "tim_plan", outcome: "needs_reconciliation" });
    expect(second).toMatchObject({ status: "tim_plan", outcome: "needs_reconciliation" });
    expect(calls).toBe(1);
    expect(listActionResultsForEvent(db, event.id)[0]).toMatchObject({
      status: "needs_reconciliation",
      result: {
        queueMode: "queued",
        commandOutcome: { state: "uncertain", error: "process interrupted" },
      },
    });
    expect(getEventDetail(db, event.id)?.failedStep).toMatchObject({
      step: "Action",
      reason: expect.stringContaining("Reconcile it before retrying"),
    });

    const createdEvent = makeEvent("duplicate-created");
    let createCalls = 0;
    const successfulRouting = createRoutingService({
      db,
      timCli: createTimCli({
        process: async () => {
          createCalls += 1;
          return { exitCode: 0, stdout: "Created plan stub: plan 89", stderr: "" };
        },
      }),
    });
    const createdAction = { ...action, type: "tim.plan.create" as const };
    await successfulRouting.routeAction(createdEvent, createdAction);
    await successfulRouting.routeAction(createdEvent, {
      ...createdAction,
      type: "tim.plan.create_and_execute",
    });
    expect(createCalls).toBe(1);
  });

  test("requires reconciliation when Tim exits successfully without a readable plan ID", async () => {
    const event = makeEvent("missing-plan-id");
    let calls = 0;
    const routing = createRoutingService({
      db,
      timCli: createTimCli({
        process: async () => {
          calls += 1;
          return { exitCode: 0, stdout: "Tim completed the request.", stderr: "" };
        },
      }),
    });
    const action = {
      type: "tim.plan.create" as const,
      projectId: project.id,
      projectName: project.name,
      description: "Create a plan and return its ID.",
    };

    expect(await routing.routeAction(event, action)).toMatchObject({
      status: "tim_plan",
      outcome: "needs_reconciliation",
    });
    expect(await routing.routeAction(event, action)).toMatchObject({
      status: "tim_plan",
      outcome: "needs_reconciliation",
    });
    expect(calls).toBe(1);
  });

  test("marks an interrupted started marker for reconciliation without starting Tim again", async () => {
    const event = makeEvent("stale-started-marker");
    createActionResult(db, {
      eventId: event.id,
      actionType: "tim.plan.create",
      status: "running",
      result: {
        idempotencyKey: JSON.stringify([event.id, "initial"]),
        projectId: project.id,
        timPlanId: null,
        queueMode: "default",
        commandOutcome: { state: "started" },
      },
    });
    let calls = 0;
    const routing = createRoutingService({
      db,
      timCli: createTimCli({
        process: async () => {
          calls += 1;
          return { exitCode: 0, stdout: "Created plan stub: plan 90", stderr: "" };
        },
      }),
    });
    const action = {
      type: "tim.plan.create" as const,
      projectId: project.id,
      projectName: project.name,
      description: "Check the result of an interrupted command.",
    };

    expect(await routing.routeAction(event, action)).toMatchObject({
      status: "tim_plan",
      outcome: "needs_reconciliation",
    });
    expect(calls).toBe(0);
    expect(listActionResultsForEvent(db, event.id)[0]).toMatchObject({
      status: "needs_reconciliation",
      error: expect.stringContaining("Reconcile it before retrying"),
    });
  });
});
