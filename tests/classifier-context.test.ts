import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { selectRecentContext } from "../src/lib/server/classifier/context";
import { openDatabase } from "../src/lib/server/db";
import { createActionResult } from "../src/lib/server/db/repositories/actionResults";
import { createClassification } from "../src/lib/server/db/repositories/classifications";
import { createEvent } from "../src/lib/server/db/repositories/events";

let databases: Database[] = [];

afterEach(() => {
  for (const db of databases) db.close();
  databases = [];
});

function setup() {
  const db = openDatabase(":memory:");
  databases.push(db);
  return db;
}

function addCapture(db: Database, id: string, receivedAt: string, text: string) {
  return createEvent(db, {
    id,
    source: "pebble",
    sourceEventId: id,
    type: "pebble.transcription",
    receivedAt,
    payload: {},
    text,
  });
}

describe("selectRecentContext", () => {
  test("limits context by count and age, excludes later captures, and orders newest first", () => {
    const db = setup();
    addCapture(db, "too-old", "2026-09-25T12:35:00.000Z", "Too old");
    addCapture(db, "older", "2026-09-25T12:46:00.000Z", "Earlier valid capture");
    addCapture(db, "newer", "2026-09-25T12:50:00.000Z", "Latest capture");
    const current = addCapture(db, "current", "2026-09-25T12:51:00.000Z", "Current capture");
    addCapture(db, "later", "2026-09-25T12:52:00.000Z", "Later capture");

    const context = selectRecentContext(db, current, { limit: 2, maxAgeMinutes: 15 });

    expect(context).toEqual([
      {
        eventId: "newer",
        text: "Latest capture",
        actionType: null,
        noteId: null,
      },
      {
        eventId: "older",
        text: "Earlier valid capture",
        actionType: null,
        noteId: null,
      },
    ]);
  });

  test("adds prior action type and a recorded downstream note ID", () => {
    const db = setup();
    const prior = addCapture(db, "prior-note", "2026-09-25T15:59:00.000Z", "Reservoir idea");
    const current = addCapture(db, "current", "2026-09-25T16:00:00.000Z", "Also make it removable");
    createClassification(db, {
      eventId: prior.id,
      actionType: "note.create",
      result: { action: { type: "note.create", body: "Reservoir idea" } },
      provider: "fake-typesafe",
      model: "jev-test",
      confidence: 0.9,
      status: "classified",
      error: null,
    });
    createActionResult(db, {
      eventId: prior.id,
      actionType: "note.create",
      status: "succeeded",
      result: { id: "note-42" },
    });

    expect(selectRecentContext(db, current)).toEqual([
      {
        eventId: prior.id,
        text: "Reservoir idea",
        actionType: "note.create",
        noteId: "note-42",
      },
    ]);
  });
});
