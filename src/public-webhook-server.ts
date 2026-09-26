import { timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import { openDatabase } from "./lib/server/db";
import { ingestPebbleWebhook } from "./lib/server/events/pebble";
import { readBodyWithinLimit } from "./lib/server/request";
import { loadConfig, type AppConfig } from "./lib/server/config";
import { log } from "./lib/server/logging";

const WEBHOOK_PATH = "/webhooks/pebble";
const RATE_LIMIT_WINDOW_MS = 60_000;

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hasValidBearerToken(authorization: string | null, secrets: string[]): boolean {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;

  const provided = Buffer.from(match[1]);
  let valid = false;
  for (const secret of secrets) {
    const expected = Buffer.from(secret);
    if (provided.length === expected.length) {
      valid = timingSafeEqual(provided, expected) || valid;
    }
  }
  return valid;
}

export function createPublicServer(config: AppConfig, db: Database, port = config.PUBLIC_PORT) {
  let windowStart = 0;
  let requestsInWindow = 0;

  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const correlationId = crypto.randomUUID();
      const url = new URL(request.url);
      let response: Response | undefined;
      let eventId: string | undefined;

      try {
        if (request.method !== "POST" || url.pathname !== WEBHOOK_PATH) {
          response = new Response("Not found", { status: 404 });
        } else if (
          !hasValidBearerToken(request.headers.get("authorization"), config.PEBBLE_WEBHOOK_SECRETS)
        ) {
          response = jsonResponse(401, { error: "Unauthorized" });
        } else {
          const now = Date.now();
          if (now - windowStart >= RATE_LIMIT_WINDOW_MS) {
            windowStart = now;
            requestsInWindow = 0;
          }

          if (requestsInWindow >= config.PEBBLE_RATE_LIMIT_PER_MINUTE) {
            response = jsonResponse(429, { error: "Rate limit exceeded" });
          } else {
            requestsInWindow++;
            const contentLength = request.headers.get("content-length");
            if (contentLength !== null && Number(contentLength) > config.PEBBLE_MAX_BODY_BYTES) {
              response = jsonResponse(413, { error: "Request body is too large" });
            } else {
              const body = await readBodyWithinLimit(request, config.PEBBLE_MAX_BODY_BYTES);
              if (body === null) {
                response = jsonResponse(413, { error: "Request body is too large" });
              } else {
                const result = await ingestPebbleWebhook(
                  db,
                  request.headers.get("content-type"),
                  body,
                  correlationId
                );
                eventId = result.eventId;
                if (result.status === 400) {
                  response = jsonResponse(400, { error: result.error, eventId });
                } else if (result.status === 200) {
                  response = jsonResponse(200, { eventId, duplicate: true });
                } else {
                  response = jsonResponse(202, { eventId });
                }
              }
            }
          }
        }
        response.headers.set("x-correlation-id", correlationId);
        return response;
      } finally {
        log(response ? "info" : "error", "public request", {
          correlationId,
          method: request.method,
          path: url.pathname,
          status: response?.status ?? 500,
          eventId,
        });
      }
    },
  });
}

if (import.meta.main) {
  const config = loadConfig();
  const db = openDatabase(config.DATABASE_PATH);
  const server = createPublicServer(config, db);
  log("info", "public listener started", { port: server.port });
}
