import type { Database } from "bun:sqlite";
import { nowIso } from "../db/json";
import { createAttempt } from "../db/repositories/attempts";
import { createEvent, findEventBySource } from "../db/repositories/events";
import { enqueueJob } from "../db/repositories/jobs";
import { log } from "../logging";

const CLASSIFICATION_JOB_MAX_ATTEMPTS = 5;

interface PebbleCapture {
  client: string;
  recordedAtMs: number;
  recordedAt: string;
  transcription: string;
}

type ParseResult = { capture: PebbleCapture; error?: never } | { error: string; capture?: never };

type IngestResult =
  | { duplicate: true; eventId: string; status: 200 }
  | { duplicate?: never; eventId: string; status: 202 }
  | { error: string; eventId: string; status: 400 };

async function readCapture(contentType: string | null, body: Uint8Array): Promise<ParseResult> {
  if (!contentType || !/^multipart\/form-data(?:;|$)/i.test(contentType)) {
    return { error: "Content-Type must be multipart/form-data." };
  }

  let formData: FormData;
  try {
    const requestBody = new ArrayBuffer(body.byteLength);
    new Uint8Array(requestBody).set(body);
    formData = await new Request("http://relay.local/webhooks/pebble", {
      method: "POST",
      headers: { "content-type": contentType },
      body: requestBody,
    }).formData();
  } catch {
    return { error: "Request body is not valid multipart/form-data." };
  }

  const transcriptionValue = formData.get("transcription");
  if (typeof transcriptionValue !== "string" || !transcriptionValue.trim()) {
    return { error: "transcription is required and must not be empty." };
  }

  const recordedAtValue = formData.get("recordedAt");
  if (typeof recordedAtValue !== "string" || !/^-?\d+$/.test(recordedAtValue)) {
    return { error: "recordedAt must be an integer Unix epoch timestamp in milliseconds." };
  }

  const recordedAtMs = Number(recordedAtValue);
  if (!Number.isSafeInteger(recordedAtMs)) {
    return { error: "recordedAt must be an integer Unix epoch timestamp in milliseconds." };
  }

  let recordedAt: string;
  try {
    recordedAt = new Date(recordedAtMs).toISOString();
  } catch {
    return { error: "recordedAt must be a valid Unix epoch timestamp in milliseconds." };
  }

  const clientValue = formData.get("client");
  if (typeof clientValue !== "string" || !clientValue.trim()) {
    return { error: "client is required and must not be empty." };
  }

  return {
    capture: {
      client: clientValue.trim(),
      recordedAtMs,
      recordedAt,
      transcription: transcriptionValue.trim(),
    },
  };
}

export async function ingestPebbleWebhook(
  db: Database,
  contentType: string | null,
  rawBody: Uint8Array,
  correlationId: string
): Promise<IngestResult> {
  const payload = {
    contentType,
    body: new TextDecoder().decode(rawBody),
  };
  const parsed = await readCapture(contentType, rawBody);

  const result = db.transaction(() => {
    if (parsed.capture) {
      const sourceEventId = `${parsed.capture.client}:${parsed.capture.recordedAtMs}`;
      const existing = findEventBySource(db, "pebble", sourceEventId);
      if (existing) return { duplicate: true as const, eventId: existing.id, status: 200 as const };

      const event = createEvent(db, {
        source: "pebble",
        sourceEventId,
        type: "pebble.transcription",
        payload,
        text: parsed.capture.transcription,
        metadata: {
          client: parsed.capture.client,
          recordedAt: parsed.capture.recordedAt,
          recordedAtMs: parsed.capture.recordedAtMs,
          correlationId,
        },
      });
      enqueueJob(db, {
        type: "classify",
        queue: "classification",
        payload: { eventId: event.id },
        eventId: event.id,
        maxAttempts: CLASSIFICATION_JOB_MAX_ATTEMPTS,
      });
      return { eventId: event.id, status: 202 as const };
    }

    const event = createEvent(db, {
      source: "pebble",
      type: "pebble.malformed",
      payload,
      metadata: { correlationId },
    });
    const failedAt = nowIso();
    createAttempt(db, {
      eventId: event.id,
      stage: "ingest",
      status: "failed",
      error: parsed.error,
      startedAt: failedAt,
      finishedAt: failedAt,
    });
    return { error: parsed.error, eventId: event.id, status: 400 as const };
  })();

  if ("error" in result) {
    log("warn", "malformed Pebble webhook", {
      correlationId,
      eventId: result.eventId,
      error: result.error,
    });
  }

  return result;
}
