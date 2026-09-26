import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { render } from "svelte/server";
import EventDetailView from "../src/lib/components/EventDetailView.svelte";
import { correctClassification } from "../src/lib/server/corrections";
import { getEventDetail } from "../src/lib/server/event-detail";
import { openDatabase } from "../src/lib/server/db";
import { createIntegrationRegistry } from "../src/lib/server/integrations/registry";
import { createLogger } from "../src/lib/server/logging";
import { createRoutingService } from "../src/lib/server/routing/service";
import { seedEventDetailFixtures } from "./event-detail-fixture";

let db: Database;

beforeEach(() => {
  db = openDatabase(":memory:");
  seedEventDetailFixtures(db);
});

afterEach(() => {
  db.close();
});

const actions = { correct: async () => {}, reclassify: async () => {} };

describe("event detail view", () => {
  test("renders recorded event history and makes the failed step clear", () => {
    const detail = getEventDetail(db, "failed-event");
    expect(detail).not.toBeNull();

    const { body } = render(EventDetailView, { props: { detail: detail!, ...actions } });

    expect(body).toContain("Raw input");
    expect(body).toContain("Normalized event");
    expect(body).toContain("Selected context");
    expect(body).toContain("Classification");
    expect(body).toContain("Processing attempts");
    expect(body).toContain("Policy result");
    expect(body).toContain("No separate policy decision is recorded.");
    expect(body).toContain("Selected route");
    expect(body).toContain("Delivery attempts");
    expect(body).toContain("Downstream object ID");
    expect(body).toContain("Mail returned HTTP 503 after the final attempt.");
    expect(body).toContain("<strong>Failed at Delivery</strong>");
    expect(body).toMatch(/class="failure-summary[^"]*" role="alert"/);

    const successfulDetail = getEventDetail(db, "successful-event");
    expect(successfulDetail).not.toBeNull();
    const successBody = render(EventDetailView, {
      props: { detail: successfulDetail!, ...actions },
    }).body;
    expect(successBody).toContain("The reservoir needs to be removable.");
    expect(successBody).toContain("Mail");
    expect(successBody).toContain("mail-task-81");
  });

  test("renders the correction form and marks corrected history", async () => {
    // The fixture Mail integration has no base URL, so this delivery fails without a request.
    const routing = createRoutingService({
      db,
      registry: createIntegrationRegistry({
        mailTransport: async () => ({ status: 201, body: { id: "mail-task-99" } }),
      }),
      log: createLogger(() => {}),
    });
    await correctClassification(
      db,
      routing,
      "successful-event",
      {
        attemptId: "correction-1",
        actionType: "task.create",
        fields: { title: "Replace the reservoir" },
      },
      "operator"
    );

    const detail = getEventDetail(db, "successful-event")!;
    const { body } = render(EventDetailView, { props: { detail, ...actions } });

    expect(body).toContain("Correct or reclassify");
    for (const type of ["task.create", "reminder.create", "note.create", "note.append"]) {
      expect(body).toContain(`<option value="${type}"`);
    }
    expect(body).not.toContain('<option value="command.execute"');
    expect(body).toMatch(/<input name="title"/);
    expect(body).toMatch(/<input name="dueAt"/);
    expect(body).toContain("Save correction and dispatch</button>");
    expect(body).toContain("Reclassify</button>");

    expect(body).toContain("Operator correction by operator");
    expect(body).toContain("replaces classification successful-classification");
    expect(body).toContain("Replaced by operator correction correction-1.");
    expect(body).toContain("Dispatched by operator correction correction-1");
    expect(body).toContain("%22correction-1%22");
  });
});
