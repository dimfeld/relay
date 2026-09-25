import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../src/lib/server/db";
import { loadConfig } from "../src/lib/server/config";
import { createPublicServer } from "../src/public-webhook-server";

const boundary = "pebble-test-boundary";
const recordedAt = "1780000000123";

function multipartBody(
  fields: Record<string, string> = {
    client: "ring",
    recordedAt,
    transcription: "  Remind me to call Sam.  ",
  },
  includeAudio = false
): string {
  const parts = Object.entries(fields).map(
    ([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  );
  if (includeAudio) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="capture.m4a"\r\nContent-Type: audio/mp4\r\n\r\nAUDIO-BYTES\r\n`
    );
  }
  return `${parts.join("")}--${boundary}--\r\n`;
}

function makeServer(overrides: Record<string, string> = {}) {
  const config = loadConfig({
    PUBLIC_PORT: "4310",
    INTERNAL_PORT: "4311",
    DATABASE_PATH: "./data/relay.sqlite",
    PEBBLE_WEBHOOK_SECRETS: "secret",
    INTERNAL_SERVICE_CREDENTIALS: '{"mail":"token"}',
    DEFAULT_EXECUTOR: "codex",
    CODEX_EXECUTABLE: "codex",
    CLAUDE_EXECUTABLE: "claude",
    ...overrides,
  });
  const db = openDatabase(":memory:");
  const server = createPublicServer(config, db, 0);
  return { db, server };
}

async function post(server: ReturnType<typeof createPublicServer>, body: string, token = "secret") {
  return fetch(new URL("/webhooks/pebble", server.url), {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
}

function eventCount(db: Database): number {
  return db.query<{ count: number }, []>("SELECT count(*) AS count FROM incoming_events").get()!
    .count;
}

function jobCount(db: Database): number {
  return db.query<{ count: number }, []>("SELECT count(*) AS count FROM jobs").get()!.count;
}

test("valid Pebble capture stores the raw body and queues one linked classification job", async () => {
  const { db, server } = makeServer();
  const body = multipartBody(undefined, true);
  try {
    const response = await post(server, body);
    const responseBody = await response.json();
    expect(response.status).toBe(202);
    expect(responseBody).toHaveProperty("eventId");

    const event = db
      .query<
        {
          id: string;
          source: string;
          source_event_id: string | null;
          type: string;
          payload: string;
          text: string | null;
          metadata: string | null;
        },
        [string]
      >(
        "SELECT id, source, source_event_id, type, payload, text, metadata FROM incoming_events WHERE id = ?"
      )
      .get(responseBody.eventId)!;
    expect(event).toMatchObject({
      id: responseBody.eventId,
      source: "pebble",
      source_event_id: `ring:${recordedAt}`,
      type: "pebble.transcription",
      text: "Remind me to call Sam.",
    });
    expect(JSON.parse(event.payload)).toEqual({
      contentType: `multipart/form-data; boundary=${boundary}`,
      body,
    });
    expect(JSON.parse(event.metadata!)).toEqual({
      client: "ring",
      recordedAt: new Date(Number(recordedAt)).toISOString(),
      recordedAtMs: Number(recordedAt),
    });
    expect(eventCount(db)).toBe(1);
    expect(jobCount(db)).toBe(1);
    expect(
      db
        .query<
          { type: string; queue: string; payload: string; event_id: string; max_attempts: number },
          []
        >("SELECT type, queue, payload, event_id, max_attempts FROM jobs")
        .get()
    ).toEqual({
      type: "classify",
      queue: "classification",
      payload: JSON.stringify({ eventId: event.id }),
      event_id: event.id,
      max_attempts: 5,
    });
  } finally {
    await server.stop();
    db.close();
  }
});

test("repeated Pebble source ID returns the existing event without another job", async () => {
  const { db, server } = makeServer();
  const body = multipartBody();
  try {
    const first = await post(server, body);
    const firstBody = await first.json();
    const duplicate = await post(server, body);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ eventId: firstBody.eventId, duplicate: true });
    expect(eventCount(db)).toBe(1);
    expect(jobCount(db)).toBe(1);
  } finally {
    await server.stop();
    db.close();
  }
});

test("bad and missing credentials are rejected before database writes", async () => {
  const { db, server } = makeServer();
  try {
    expect((await post(server, multipartBody(), "wrong-token")).status).toBe(401);
    expect((await post(server, multipartBody(), "")).status).toBe(401);
    expect(eventCount(db)).toBe(0);
    expect(jobCount(db)).toBe(0);
  } finally {
    await server.stop();
    db.close();
  }
});

test("malformed multipart input is retained with a failed ingest attempt", async () => {
  const { db, server } = makeServer();
  const body = multipartBody({ client: "ring", recordedAt, extra: "no transcription" });
  try {
    const response = await post(server, body);
    const responseBody = await response.json();
    expect(response.status).toBe(400);
    expect(responseBody.eventId).toEqual(expect.any(String));
    expect(responseBody.error).toContain("transcription");

    const event = db
      .query<{ type: string; source_event_id: string | null; payload: string }, [string]>(
        "SELECT type, source_event_id, payload FROM incoming_events WHERE id = ?"
      )
      .get(responseBody.eventId)!;
    expect(event.type).toBe("pebble.malformed");
    expect(event.source_event_id).toBeNull();
    expect(JSON.parse(event.payload)).toEqual({
      contentType: `multipart/form-data; boundary=${boundary}`,
      body,
    });
    expect(
      db
        .query<
          { stage: string; status: string; error: string; finished_at: string | null },
          [string]
        >("SELECT stage, status, error, finished_at FROM processing_attempts WHERE event_id = ?")
        .get(responseBody.eventId)
    ).toMatchObject({
      stage: "ingest",
      status: "failed",
      finished_at: expect.any(String),
    });
    expect(
      db
        .query<{ error: string }, [string]>(
          "SELECT error FROM processing_attempts WHERE event_id = ?"
        )
        .get(responseBody.eventId)?.error
    ).toContain("transcription");
    expect(eventCount(db)).toBe(1);
    expect(jobCount(db)).toBe(0);
  } finally {
    await server.stop();
    db.close();
  }
});

test("oversized bodies and requests above the configured rate are rejected", async () => {
  const oversized = makeServer({ PEBBLE_MAX_BODY_BYTES: "64" });
  try {
    expect((await post(oversized.server, multipartBody())).status).toBe(413);
    expect(eventCount(oversized.db)).toBe(0);
    expect(jobCount(oversized.db)).toBe(0);
  } finally {
    await oversized.server.stop();
    oversized.db.close();
  }

  const rateLimited = makeServer({ PEBBLE_RATE_LIMIT_PER_MINUTE: "1" });
  try {
    expect((await post(rateLimited.server, multipartBody())).status).toBe(202);
    expect(
      (
        await post(
          rateLimited.server,
          multipartBody({ client: "ring", recordedAt: "1780000000124", transcription: "Next" })
        )
      ).status
    ).toBe(429);
    expect(eventCount(rateLimited.db)).toBe(1);
    expect(jobCount(rateLimited.db)).toBe(1);
  } finally {
    await rateLimited.server.stop();
    rateLimited.db.close();
  }
});
