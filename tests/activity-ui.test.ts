import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { render } from "svelte/server";
import ActivityCommandForm from "../src/lib/components/ActivityCommandForm.svelte";
import ActivityView from "../src/lib/components/ActivityView.svelte";
import {
  createActivityCommandFormState,
  submitActivityCommandForm,
} from "../src/lib/activity-command";
import { getActivityFilterOptions, listActivity } from "../src/lib/server/activity";
import { openDatabase } from "../src/lib/server/db";
import { createActionResult } from "../src/lib/server/db/repositories/actionResults";
import { createClassification } from "../src/lib/server/db/repositories/classifications";
import { createDelivery } from "../src/lib/server/db/repositories/deliveries";
import { createEvent } from "../src/lib/server/db/repositories/events";
import {
  createEventRoute,
  createIntegration,
} from "../src/lib/server/db/repositories/integrations";

let db: Database;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function seedActivity(db: Database) {
  const mail = createIntegration(db, { name: "Mail", kind: "mail", config: {} });
  const mailRoute = createEventRoute(db, {
    id: "mail-route",
    eventType: "task.create",
    integrationId: mail.id,
    config: {},
  });

  createEvent(db, {
    id: "succeeded",
    source: "mail",
    type: "task.create",
    receivedAt: "2026-04-01T08:30:00.000Z",
    text: "Call Sam about the launch",
    payload: { title: "Call Sam" },
  });
  createClassification(db, {
    id: "classification-succeeded",
    eventId: "succeeded",
    actionType: "task.create",
    result: { action: { type: "task.create" } },
    provider: "typesafe",
    model: "jev-test",
    confidence: 0.92,
    status: "classified",
    error: null,
    createdAt: "2026-04-01T08:31:00.000Z",
  });
  createDelivery(db, {
    id: "delivery-succeeded",
    eventId: "succeeded",
    integrationId: mail.id,
    routeId: mailRoute.id,
    status: "succeeded",
    idempotencyKey: "succeeded-key",
    request: {},
  });

  createEvent(db, {
    id: "needs-review",
    source: "pebble",
    type: "capture",
    receivedAt: "2026-04-03T10:00:00.000Z",
    text: "Maybe turn this into a note",
    payload: { text: "Maybe turn this into a note" },
  });
  createClassification(db, {
    id: "classification-review",
    eventId: "needs-review",
    actionType: "note.create",
    result: { reason: "ambiguous" },
    provider: "typesafe",
    model: "jev-test",
    confidence: 0.42,
    status: "needs_review",
    error: "The action needs review.",
    createdAt: "2026-04-03T10:01:00.000Z",
  });

  createEvent(db, {
    id: "failed",
    source: "mail",
    type: "task.create",
    receivedAt: "2026-04-04T11:00:00.000Z",
    text: "Schedule the review",
    payload: { title: "Review" },
  });
  createDelivery(db, {
    id: "delivery-failed",
    eventId: "failed",
    integrationId: mail.id,
    routeId: mailRoute.id,
    status: "dead",
    idempotencyKey: "failed-key",
    request: {},
  });
  createActionResult(db, {
    id: "action-failed",
    eventId: "failed",
    actionType: "task.create",
    status: "failed",
    error: "Mail is unavailable.",
  });
}

function renderActivity(
  events: ReturnType<typeof listActivity>,
  options: ReturnType<typeof getActivityFilterOptions>
) {
  return render(ActivityView, {
    props: {
      events,
      options,
      submitCommand: async () => "event-id",
      testCommand: async () => {
        throw new Error("Unused test command");
      },
      refreshActivity: async () => {},
    },
  });
}

describe("Activity view", () => {
  test("renders fixture rows, filters, problem markers, and empty results", () => {
    seedActivity(db);
    const options = getActivityFilterOptions(db);
    const events = listActivity(db);
    const { body } = renderActivity(events, options);
    const eventRows = body.match(/<tr class="[^"]*">.*?<\/tr>/g) ?? [];

    expect(eventRows).toHaveLength(3);
    expect(eventRows[0]).toContain(">mail</td>");
    expect(eventRows[0]).toContain("2026-04-04T11:00:00.000Z");
    expect(eventRows[0]).toContain("Schedule the review");
    expect(eventRows[0]).toContain('href="/activity/failed"');
    expect(eventRows[0]).toContain("<span>task.create</span>");
    expect(eventRows[0]).toContain(">Mail");
    expect(eventRows[0]).toContain(">failed</span>");
    expect(eventRows[0]).toContain("Mail is unavailable.");
    expect(eventRows[0]).toMatch(/class="[^"]*\battention\b/);
    expect(eventRows[0]).toMatch(/class="[^"]*\bproblem\b/);

    expect(eventRows[1]).toContain(">pebble</td>");
    expect(eventRows[1]).toContain("2026-04-03T10:00:00.000Z");
    expect(eventRows[1]).toContain("Maybe turn this into a note");
    expect(eventRows[1]).toContain("<span>note.create</span>");
    expect(eventRows[1]).toContain("needs review");
    expect(eventRows[1]).toContain("The action needs review.");
    expect(eventRows[1]).toMatch(/class="[^"]*\battention\b/);
    expect(eventRows[1]).toMatch(/class="[^"]*\bproblem\b/);

    expect(eventRows[2]).toContain(">mail</td>");
    expect(eventRows[2]).toContain("2026-04-01T08:30:00.000Z");
    expect(eventRows[2]).toContain("Call Sam about the launch");
    expect(eventRows[2]).toContain("<span>task.create</span>");
    expect(eventRows[2]).toContain(">Mail");
    expect(eventRows[2]).toContain("succeeded");
    expect(eventRows[2]).toContain("92% confidence");

    expect(body).toContain('<option value="mail">mail</option>');
    expect(body).toContain('<option value="pebble">pebble</option>');
    expect(body).toContain('<option value="failed">failed</option>');
    expect(body).toContain('<option value="needs_review">needs review</option>');
    expect(body).toContain('<option value="task.create">task.create</option>');
    expect(body).toContain('<option value="note.create">note.create</option>');
    expect(body.match(/type="date"/g)).toHaveLength(2);

    const failedEvents = listActivity(db, { status: "failed" });
    const failedBody = renderActivity(failedEvents, options).body;
    expect(failedBody).toContain("Schedule the review");
    expect(failedBody).not.toContain("Maybe turn this into a note");
    expect(failedBody).not.toContain("Call Sam about the launch");

    const emptyEvents = listActivity(db, { source: "missing" });
    const emptyBody = renderActivity(emptyEvents, options).body;
    expect(emptyBody).toContain("No events match these filters.");
    expect(emptyBody).toContain('aria-label="Submit a command"');
    expect(emptyBody).toContain('id="command-text"');
  });

  test("command form shows pending, success, and failure states", () => {
    const submitCommand = async () => "event/with space";
    const refreshActivity = async () => {};

    const initial = render(ActivityCommandForm, {
      props: {
        state: createActivityCommandFormState(),
        submitCommand,
        refreshActivity,
      },
    }).body;
    expect(initial).toMatch(/<label for="command-text"[^>]*>Command<\/label>/);
    expect(initial).toContain("Submit command</button>");
    expect(initial).toContain("Test mode (show results without taking action)");

    const pendingState = createActivityCommandFormState();
    pendingState.text = "Call Sam";
    pendingState.pending = true;
    const pending = render(ActivityCommandForm, {
      props: { state: pendingState, submitCommand, refreshActivity },
    }).body;
    expect(pending).toContain("Submitting…</button>");
    expect(pending).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(pending).toMatch(/<textarea[^>]*disabled/);

    const successState = createActivityCommandFormState();
    successState.eventId = "event/with space";
    const success = render(ActivityCommandForm, {
      props: { state: successState, submitCommand, refreshActivity },
    }).body;
    expect(success).toContain('href="/activity/event%2Fwith%20space"');
    expect(success).toContain("Command submitted.");

    const failureState = createActivityCommandFormState();
    failureState.text = "Call Sam tomorrow";
    failureState.error = "The server could not save this command.";
    const failure = render(ActivityCommandForm, {
      props: { state: failureState, submitCommand, refreshActivity },
    }).body;
    expect(failure).toContain('role="alert"');
    expect(failure).toContain("The server could not save this command.");
    expect(failure).toContain("Call Sam tomorrow");
  });

  test("command form keeps its submission pending, clears on success, and preserves errors", async () => {
    const state = createActivityCommandFormState();
    state.text = "Call Sam";
    let resolveSubmission!: (eventId: string) => void;
    const pendingResult = new Promise<string>((resolve) => {
      resolveSubmission = resolve;
    });
    let submissionId = "";
    let refreshCount = 0;

    const pending = submitActivityCommandForm(
      state,
      async (input) => {
        submissionId = input.submissionId;
        return pendingResult;
      },
      async () => {
        refreshCount += 1;
      }
    );
    expect(state.pending).toBe(true);
    expect(submissionId).toMatch(/^[0-9a-f-]{36}$/i);
    resolveSubmission("event-1");
    await pending;

    expect(state).toMatchObject({ pending: false, eventId: "event-1", text: "", error: null });
    expect(refreshCount).toBe(1);

    state.text = "Call Sam";
    await submitActivityCommandForm(
      state,
      async (input) => {
        expect(input.submissionId).not.toBe(submissionId);
        submissionId = input.submissionId;
        throw new Error("The server could not save this command.");
      },
      async () => {}
    );
    expect(state).toMatchObject({
      pending: false,
      text: "Call Sam",
      error: "The server could not save this command.",
    });

    const retrySubmissionId = state.submission!.id;
    await submitActivityCommandForm(
      state,
      async (input) => {
        expect(input.submissionId).toBe(retrySubmissionId);
        return "event-2";
      },
      async () => {}
    );
    expect(state.eventId).toBe("event-2");
  });

  test("test mode shows a preview and does not submit or refresh Activity", async () => {
    const state = createActivityCommandFormState();
    state.text = "Call Sam";
    state.testMode = true;
    const preview = {
      status: "classified" as const,
      action: {
        type: "task.create" as const,
        title: "Call Sam",
        notes: null,
        dueAt: null,
        categoryId: null,
      },
      record: {
        normalizedText: "Call Sam",
        signals: {} as never,
        selectedContextIds: [],
        jev: null,
        luna: [],
        reason: "classified as task.create",
      },
      route: { id: "task-route", integrationId: "mail", integrationName: "Mail" },
    };
    let submissions = 0;
    let refreshes = 0;
    await submitActivityCommandForm(
      state,
      async () => {
        submissions++;
        return "unexpected";
      },
      async () => {
        refreshes++;
      },
      async () => preview
    );
    expect(submissions).toBe(0);
    expect(refreshes).toBe(0);
    expect(state.text).toBe("Call Sam");
    expect(state.eventId).toBeNull();
    expect(state.preview).toEqual(preview);
    const body = render(ActivityCommandForm, {
      props: { state, submitCommand: async () => "unexpected", refreshActivity: async () => {} },
    }).body;
    expect(body).toContain("No action was taken. No event was saved.");
    expect(body).toContain("Mail (route task-route)");
    expect(body).toContain("Call Sam");
    expect(body).toContain("Classification and extraction details");
  });
});
