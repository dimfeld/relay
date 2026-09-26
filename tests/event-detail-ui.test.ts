import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { render } from "svelte/server";
import EventDetailView from "../src/lib/components/EventDetailView.svelte";
import { getEventDetail } from "../src/lib/server/event-detail";
import { openDatabase } from "../src/lib/server/db";
import { seedEventDetailFixtures } from "./event-detail-fixture";

let db: Database;

beforeEach(() => {
  db = openDatabase(":memory:");
  seedEventDetailFixtures(db);
});

afterEach(() => {
  db.close();
});

describe("event detail view", () => {
  test("renders recorded event history and makes the failed step clear", () => {
    const detail = getEventDetail(db, "failed-event");
    expect(detail).not.toBeNull();

    const { body } = render(EventDetailView, { props: { detail: detail! } });

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
    const successBody = render(EventDetailView, { props: { detail: successfulDetail! } }).body;
    expect(successBody).toContain("The reservoir needs to be removable.");
    expect(successBody).toContain("Mail");
    expect(successBody).toContain("mail-task-81");
  });
});
