import { describe, expect, test } from "bun:test";
import { preprocess } from "../src/lib/server/classifier/preprocess";
import { withRateLimitRetry } from "../src/lib/server/classifier/retry";
import { classifyCapture, type ClassifyInput } from "../src/lib/server/classifier/service";
import { ProviderError, type ContextItem } from "../src/lib/server/classifier/types";
import { fakeJev, fakeLuna } from "./classifier-fakes";

const projects = [
  { id: "project-omni", name: "OmniApp", aliases: ["omni"] },
  { id: "project-relay", name: "Relay", aliases: [] },
];

const noteContext: ContextItem[] = [
  {
    eventId: "event-earlier",
    text: "Note: design a bracket for the camera",
    actionType: "note.create",
    noteId: "note-42",
  },
];

const noSleep = { sleep: async () => {} };

function input(text: string, overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    text,
    referenceTime: "2026-09-25T16:00:00.000Z",
    timeZone: "America/Los_Angeles",
    wakeName: "Tim",
    projects,
    context: [],
    ...overrides,
  };
}

const baseAnswers = { coding_executor: "unspecified", reminder_time: "missing" };

describe("classifyCapture", () => {
  test.each([
    {
      name: "task.create",
      text: "Add buy printer filament to my list",
      answers: { action_type: "task" },
      luna: { type: "task.create", title: "Buy printer filament", notes: null, dueAt: null },
      expected: { type: "task.create", title: "Buy printer filament", notes: null, dueAt: null },
    },
    {
      name: "reminder.create",
      text: "Remind me tomorrow at 9am to call the dentist",
      answers: { action_type: "reminder", reminder_time: "stated" },
      luna: {
        type: "reminder.create",
        text: "Call the dentist",
        remindAt: "2026-09-26T09:00:00-07:00",
        timeZone: "America/Los_Angeles",
        originalTimePhrase: "tomorrow at 9am",
      },
      expected: {
        type: "reminder.create",
        text: "Call the dentist",
        remindAt: "2026-09-26T09:00:00-07:00",
        timeZone: "America/Los_Angeles",
        originalTimePhrase: "tomorrow at 9am",
      },
    },
    {
      name: "note.create",
      text: "Idea: a magnetic mount for the camera",
      answers: { action_type: "new_note" },
      luna: {
        type: "note.create",
        title: null,
        body: "A magnetic mount for the camera",
        topic: null,
      },
      expected: {
        type: "note.create",
        title: null,
        body: "A magnetic mount for the camera",
        topic: null,
      },
    },
    {
      name: "note.append",
      text: "Also make the mounting plate removable",
      context: noteContext,
      answers: { action_type: "note_continuation", note_target: "context_1" },
      luna: { type: "note.append", body: "Make the mounting plate removable" },
      expected: {
        type: "note.append",
        body: "Make the mounting plate removable",
        targetId: "note-42",
        contextEventId: "event-earlier",
      },
    },
    {
      name: "command.execute",
      text: "Tim, use Codex to add USPS tracking support to Omni",
      answers: { action_type: "coding_request", coding_executor: "codex" },
      luna: { type: "command.execute", project: "Omni", task: "Add USPS tracking support" },
      expected: {
        type: "command.execute",
        command: {
          action: "coding.task",
          projectId: "project-omni",
          projectName: "OmniApp",
          task: "Add USPS tracking support",
          requestedExecutor: { provider: "codex" },
        },
      },
    },
  ])("classifies $name", async ({ text, context, answers, luna, expected }) => {
    const jev = fakeJev({ ...baseAnswers, ...answers });
    const extractor = fakeLuna(luna);
    const result = await classifyCapture(input(text, { context: context ?? [] }), {
      jev,
      luna: extractor,
      retry: noSleep,
    });

    expect(result.status).toBe("classified");
    if (result.status !== "classified") return;
    expect(result.action).toEqual(expected as never);
    expect(extractor.requests).toHaveLength(1);
    expect(extractor.requests[0].actionType).toBe(expected.type as never);
    expect(extractor.requests[0].instructions).toContain(`Always set "type" to "${expected.type}"`);
    expect(result.record.jev).toMatchObject({
      provider: "fake-typesafe",
      model: "jev-test",
      latencyMs: 12,
      usage: { inputTokens: 100, outputTokens: 3 },
      actionType: expected.type,
      confidence: 0.9,
    });
    expect(result.record.luna).toEqual([
      expect.objectContaining({ provider: "fake-openai", model: "luna-test", valid: true }),
    ]);
  });

  test("records unknown input without calling Luna", async () => {
    const extractor = fakeLuna();
    const result = await classifyCapture(input("the weather is nice"), {
      jev: fakeJev({ ...baseAnswers, action_type: "unknown" }),
      luna: extractor,
    });
    expect(result).toMatchObject({
      status: "classified",
      action: { type: "unknown", reason: "Jev selected unknown" },
    });
    expect(extractor.requests).toHaveLength(0);
  });

  test("asks every choice question in one Jev request", async () => {
    const jev = fakeJev({ ...baseAnswers, action_type: "unknown" });
    await classifyCapture(input("Also add a hinge", { context: noteContext }), {
      jev,
      luna: fakeLuna(),
    });
    expect(jev.requests).toHaveLength(1);
    const { questions, state } = jev.requests[0];
    expect(Object.keys(questions).sort()).toEqual([
      "action_type",
      "coding_executor",
      "note_target",
      "reminder_time",
    ]);
    expect(questions.note_target.options).toHaveProperty("context_1");
    expect(questions.note_target.options).toHaveProperty("none");
    expect(state).toMatchObject({
      capture: "Also add a hinge",
      recentContext: [{ label: "context_1" }],
    });
  });

  test("repairs invalid fields once", async () => {
    const extractor = fakeLuna(
      { type: "task.create", title: "", notes: null },
      { type: "task.create", title: "Water the plants", notes: null, dueAt: null }
    );
    const result = await classifyCapture(input("I need to water the plants"), {
      jev: fakeJev({ ...baseAnswers, action_type: "task" }),
      luna: extractor,
    });
    expect(result).toMatchObject({ status: "classified", action: { title: "Water the plants" } });
    expect(extractor.requests).toHaveLength(2);
    expect(JSON.parse(extractor.requests[1].prompt).repair.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("title")])
    );
    expect(result.record.luna.map((call) => [call.kind, call.valid])).toEqual([
      ["extract", false],
      ["repair", true],
    ]);
  });

  test("marks needs_review when repair fails", async () => {
    const extractor = fakeLuna({ type: "note.create", body: 5 }, "not json");
    const result = await classifyCapture(input("Idea: glow in the dark labels"), {
      jev: fakeJev({ ...baseAnswers, action_type: "new_note" }),
      luna: extractor,
    });
    expect(result).toMatchObject({ status: "needs_review", actionType: "note.create" });
    expect(result.record.reason).toBe("Luna output failed validation after repair");
    expect(extractor.requests).toHaveLength(2);
  });

  test("rejects a Luna output that changes the action type", async () => {
    const changed = { type: "command.execute", project: "Relay", task: "Deploy" };
    const result = await classifyCapture(input("Buy milk"), {
      jev: fakeJev({ ...baseAnswers, action_type: "task" }),
      luna: fakeLuna(changed, changed),
    });
    expect(result).toMatchObject({ status: "needs_review", actionType: "task.create" });
    expect(result.record.luna[0].issues[0]).toContain('must be "task.create"');
  });

  test("marks an uncertain note target as needs_review without extraction", async () => {
    for (const [context, answers] of [
      [noteContext, { note_target: "none" }],
      [[], {}],
    ] as const) {
      const extractor = fakeLuna();
      const result = await classifyCapture(input("Also paint it blue", { context: [...context] }), {
        jev: fakeJev({ ...baseAnswers, action_type: "note_continuation", ...answers }),
        luna: extractor,
      });
      expect(result).toMatchObject({ status: "needs_review", actionType: "note.append" });
      expect(result.record.reason).toBe("note continuation target is unclear");
      expect(extractor.requests).toHaveLength(0);
    }
  });

  test("marks a coding request for an unregistered project as needs_review", async () => {
    const result = await classifyCapture(input("Tim, have Claude fix the login bug in Gizmo"), {
      jev: fakeJev({ ...baseAnswers, action_type: "coding_request", coding_executor: "claude" }),
      luna: fakeLuna({ type: "command.execute", project: "Gizmo", task: "Fix the login bug" }),
    });
    expect(result).toMatchObject({ status: "needs_review", actionType: "command.execute" });
    expect(result.record.reason).toBe("coding request does not name a registered project");
  });

  test("rejects model supplied commands, paths, and flags", async () => {
    const unsafe = {
      type: "command.execute",
      project: "Relay",
      task: "Update dependencies",
      cwd: "/",
      executable: "rm",
    };
    const result = await classifyCapture(input("Tim, update the Relay dependencies"), {
      jev: fakeJev({ ...baseAnswers, action_type: "coding_request" }),
      luna: fakeLuna(unsafe, unsafe),
    });
    expect(result.status).toBe("needs_review");
  });

  test("marks a reminder without a resolvable time as needs_review", async () => {
    const missing = fakeLuna();
    const noTime = await classifyCapture(input("Remind me to call mom"), {
      jev: fakeJev({ ...baseAnswers, action_type: "reminder", reminder_time: "missing" }),
      luna: missing,
    });
    expect(noTime.record.reason).toBe("reminder time is missing");
    expect(missing.requests).toHaveLength(0);

    const unresolved = await classifyCapture(input("Remind me sometime soon to call mom"), {
      jev: fakeJev({ ...baseAnswers, action_type: "reminder", reminder_time: "stated" }),
      luna: fakeLuna({
        type: "reminder.create",
        text: "Call mom",
        remindAt: null,
        timeZone: null,
        originalTimePhrase: "sometime soon",
      }),
    });
    expect(unresolved).toMatchObject({ status: "needs_review", actionType: "reminder.create" });
    expect(unresolved.record.reason).toBe("reminder time could not be resolved");
  });

  test("reports a Jev failure without calling Luna", async () => {
    const extractor = fakeLuna();
    const result = await classifyCapture(input("Buy milk"), {
      jev: fakeJev(new ProviderError("typesafe", "service unavailable")),
      luna: extractor,
      retry: noSleep,
    });
    expect(result).toMatchObject({ status: "failed", error: "service unavailable" });
    expect(extractor.requests).toHaveLength(0);
  });

  test("reports a Luna failure", async () => {
    const result = await classifyCapture(input("Buy milk"), {
      jev: fakeJev({ ...baseAnswers, action_type: "task" }),
      luna: fakeLuna(new ProviderError("openai", "connection reset")),
    });
    expect(result).toMatchObject({ status: "failed", error: "connection reset" });
    expect(result.record.jev?.actionType).toBe("task.create");
  });

  test("retries provider calls that fail with 429", async () => {
    const sleeps: number[] = [];
    const rateLimited = new ProviderError("typesafe", "rate limited", { rateLimited: true });
    const jev = fakeJev(rateLimited, { ...baseAnswers, action_type: "task" });
    const extractor = fakeLuna(
      new ProviderError("openai", "rate limited", { rateLimited: true, retryAfterMs: 250 }),
      { type: "task.create", title: "Buy milk", notes: null, dueAt: null }
    );
    const result = await classifyCapture(input("Buy milk"), {
      jev,
      luna: extractor,
      retry: { sleep: async (ms) => void sleeps.push(ms) },
    });
    expect(result.status).toBe("classified");
    expect(jev.requests).toHaveLength(2);
    expect(extractor.requests).toHaveLength(2);
    expect(sleeps).toEqual([500, 250]);
  });
});

describe("withRateLimitRetry", () => {
  test("stops after the retry limit and does not retry other errors", async () => {
    let calls = 0;
    const rateLimited = () => {
      calls++;
      throw new ProviderError("openai", "rate limited", { rateLimited: true });
    };
    await expect(withRateLimitRetry(async () => rateLimited(), noSleep)).rejects.toThrow(
      "rate limited"
    );
    expect(calls).toBe(3);

    calls = 0;
    await expect(
      withRateLimitRetry(async () => {
        calls++;
        throw new ProviderError("openai", "bad request");
      }, noSleep)
    ).rejects.toThrow("bad request");
    expect(calls).toBe(1);
  });
});

describe("preprocess", () => {
  test("normalizes text and finds exact signals", () => {
    const result = preprocess("  Hey  Tim,   ask Claude to fix the omni build ", {
      wakeName: "Tim",
      projects,
    });
    expect(result.text).toBe("Hey Tim, ask Claude to fix the omni build");
    expect(result.signals).toEqual({
      wakeNameDetected: true,
      projectHints: [{ projectId: "project-omni", projectName: "OmniApp", matched: "omni" }],
      executorMentions: ["claude"],
    });
  });

  test("does not match the wake name or aliases inside other words", () => {
    const result = preprocess("Timothy said the omnibus is late", { wakeName: "Tim", projects });
    expect(result.signals.wakeNameDetected).toBe(false);
    expect(result.signals.projectHints).toEqual([]);
  });
});
