import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { loadClassifierConfig, loadConfig } from "../src/lib/server/config";
import { openDatabase } from "../src/lib/server/db";
import { listDeliveriesForEvent } from "../src/lib/server/db/repositories/deliveries";
import { createCaptureInTransaction } from "../src/lib/server/events/capture";
import { syncIntegrationCatalog } from "../src/lib/server/integrations/config";
import { createIntegrationRegistry } from "../src/lib/server/integrations/registry";
import type { HttpRequest } from "../src/lib/server/integrations/types";
import { createRoutingService } from "../src/lib/server/routing/service";
import { startBackgroundWorkers } from "../src/lib/server/runtime";
import { fakeJev, fakeLuna } from "./classifier-fakes";

let db: Database;
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stop?.();
  stop = undefined;
  db.close();
});

test("the started workers classify a queued capture and deliver it to the configured owner", async () => {
  db = openDatabase(":memory:");
  const config = loadConfig({
    PUBLIC_PORT: "4310",
    INTERNAL_PORT: "4311",
    DATABASE_PATH: ":memory:",
    PEBBLE_WEBHOOK_SECRETS: "secret",
    INTERNAL_SERVICE_CREDENTIALS: JSON.stringify({
      mail: { token: "mail-token", capabilities: ["events:publish"] },
    }),
    DEFAULT_EXECUTOR: "codex",
    CODEX_EXECUTABLE: "codex",
    CLAUDE_EXECUTABLE: "claude",
    WORKER_POLL_INTERVAL_MS: "5",
  });
  syncIntegrationCatalog(db, {
    integrations: [{ id: "mail", name: "Mail", kind: "mail", baseUrl: "https://mail.test" }],
    routes: ["task.create", "reminder.create", "note.create"].map((actionType) => ({
      id: actionType,
      eventType: null,
      actionType,
      integrationId: "mail",
    })),
  });

  const requests: HttpRequest[] = [];
  let delivered!: () => void;
  const done = new Promise<void>((resolve) => (delivered = resolve));
  const transport = async (request: HttpRequest) => {
    requests.push(request);
    if (request.method === "GET") {
      return { status: 200, body: { categories: [{ id: "cat-hobby", name: "Hobby" }] } };
    }
    delivered();
    return { status: 201, body: { id: "mail-todo-1" } };
  };
  const workers = startBackgroundWorkers({
    db,
    config,
    routing: createRoutingService({
      db,
      registry: createIntegrationRegistry({ mailTransport: transport }),
    }),
    classifierConfig: loadClassifierConfig({ TYPESAFE_API_KEY: "key", OPENAI_API_KEY: "key" }),
    providers: {
      jev: fakeJev({
        action_type: "task",
        coding_executor: "unspecified",
        reminder_time: "missing",
        category: "category_1",
      }),
      luna: fakeLuna({ type: "task.create", title: "Buy filament", notes: null, dueAt: null }),
    },
    categoryTransport: transport,
  });
  stop = workers.stop;
  expect(Object.keys(workers.workers).sort()).toEqual(["classification", "delivery"]);

  const event = db.transaction(() =>
    createCaptureInTransaction(db, {
      source: "pebble",
      type: "pebble.transcription",
      payload: {},
      text: "Buy filament",
    })
  )();
  await done;

  expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
    "GET https://mail.test/categories",
    "POST https://mail.test/todos",
  ]);
  expect(JSON.parse(requests[1]!.body!)).toMatchObject({
    title: "Buy filament",
    categoryId: "cat-hobby",
  });
  await workers.stop();
  expect(listDeliveriesForEvent(db, event.id)).toMatchObject([{ status: "succeeded" }]);
});
