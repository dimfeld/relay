import { describe, expect, test } from "bun:test";
import { createTypeSafeJev } from "../src/lib/server/classifier/adapters/jev";
import { createOpenAILuna } from "../src/lib/server/classifier/adapters/luna";
import { buildLunaRequest } from "../src/lib/server/classifier/extraction";
import { preprocess } from "../src/lib/server/classifier/preprocess";
import { ProviderError } from "../src/lib/server/classifier/types";

const API_KEY = "secret-test-key";

function fakeFetch(respond: (url: string, body: unknown) => Response) {
  const requests: { url: string; headers: Headers; body: any }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, headers: new Headers(init?.headers), body });
    return respond(url, body);
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const lunaRequest = buildLunaRequest({
  actionType: "task.create",
  preprocessed: preprocess("Buy milk", { projects: [] }),
  context: [],
  referenceTime: "2026-09-25T16:00:00.000Z",
});

function responsesApiBody(text: string) {
  return {
    id: "resp_1",
    object: "response",
    created_at: 1_790_000_000,
    status: "completed",
    model: "gpt-6-luna-2026-09-01",
    output: [
      {
        type: "message",
        id: "msg_1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 50, output_tokens: 10 },
  };
}

describe("TypeSafe Jev adapter", () => {
  test("sends choice questions and maps answers", async () => {
    const { fetch, requests } = fakeFetch(() =>
      json({
        model: "jev-1",
        answers: {
          action_type: {
            type: "choice",
            choice: "task",
            confidence: 0.8,
            probabilities: { task: 0.8, unknown: 0.2 },
          },
        },
        usage: { input_tokens: 40, output_tokens: 2 },
      })
    );
    const jev = createTypeSafeJev({ apiKey: API_KEY, model: "jev-latest", fetch });
    const response = await jev.classify({
      state: { capture: "Buy milk" },
      questions: {
        action_type: { instructions: "Which?", options: { task: "A task", unknown: "?" } },
      },
    });

    expect(requests[0].body).toEqual({
      model: "jev-latest",
      state: { capture: "Buy milk" },
      questions: {
        action_type: {
          type: "choice",
          instructions: "Which?",
          criteria: { task: "A task", unknown: "?" },
        },
      },
    });
    expect(response).toMatchObject({
      provider: "typesafe",
      model: "jev-1",
      usage: { inputTokens: 40, outputTokens: 2 },
      answers: {
        action_type: {
          choice: "task",
          confidence: 0.8,
          probabilities: { task: 0.8, unknown: 0.2 },
        },
      },
    });
  });

  test("reports 429 as a rate limited provider error without the API key", async () => {
    const { fetch, requests } = fakeFetch(() =>
      json({ error: "slow down" }, 429, { "retry-after-ms": "100" })
    );
    const jev = createTypeSafeJev({ apiKey: API_KEY, model: "jev-latest", fetch });
    const error = await jev
      .classify({
        state: { capture: "x" },
        questions: { q: { instructions: "?", options: { a: "", b: "" } } },
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ provider: "typesafe", rateLimited: true, retryAfterMs: 100 });
    expect(error.message).not.toContain(API_KEY);
    expect(requests).toHaveLength(1);
  });
});

describe("OpenAI Luna adapter", () => {
  test("returns the schema checked object with metadata", async () => {
    const output = { type: "task.create", title: "Buy milk", notes: null, dueAt: null };
    const { fetch, requests } = fakeFetch(() => json(responsesApiBody(JSON.stringify(output))));
    const luna = createOpenAILuna({ apiKey: API_KEY, model: "gpt-6-luna", fetch });
    const response = await luna.extract(lunaRequest);

    expect(requests[0].url).toEndWith("/responses");
    expect(requests[0].body.model).toBe("gpt-6-luna");
    expect(response).toMatchObject({
      provider: "openai",
      model: "gpt-6-luna-2026-09-01",
      usage: { inputTokens: 50, outputTokens: 10 },
      output,
    });
  });

  test("returns invalid output for the service to validate", async () => {
    const { fetch } = fakeFetch(() => json(responsesApiBody('{"type":"unknown"}')));
    const luna = createOpenAILuna({ apiKey: API_KEY, model: "gpt-6-luna", fetch });
    expect((await luna.extract(lunaRequest)).output).toEqual({ type: "unknown" });
  });

  test("reports 429 as a rate limited provider error without retrying in the SDK", async () => {
    const { fetch, requests } = fakeFetch(() =>
      json({ error: { message: "Rate limit reached", type: "rate_limit" } }, 429, {
        "retry-after": "2",
      })
    );
    const luna = createOpenAILuna({ apiKey: API_KEY, model: "gpt-6-luna", fetch });
    const error = await luna.extract(lunaRequest).catch((caught) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ provider: "openai", rateLimited: true, retryAfterMs: 2_000 });
    expect(error.message).not.toContain(API_KEY);
    expect(requests).toHaveLength(1);
  });
});
