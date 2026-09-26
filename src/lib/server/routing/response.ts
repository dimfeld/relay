import type { HttpResponse } from "../integrations/types";

/**
 * Stored response bodies are for debugging only. Four KiB keeps a typical owner error payload
 * readable while keeping delivery rows small when an owner returns a large page.
 */
export const MAX_RECORDED_BODY_CHARS = 4_096;

const SENSITIVE_KEY = /authorization|cookie|password|secret|token|api[-_]?key/i;
const REDACTED = "[redacted]";

/** The owner response as stored on a delivery row. Request headers are never stored. */
export interface DeliveryResponse {
  status: number;
  body: unknown;
  bodyTruncated: boolean;
  downstreamId: string | null;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : redact(entry),
    ])
  );
}

/** Remove credential-like fields and bound the body size before a response is stored. */
export function recordResponse(
  response: HttpResponse,
  downstreamId: string | null = null
): DeliveryResponse {
  const body = redact(response.body);
  const text = typeof body === "string" ? body : JSON.stringify(body ?? null);
  if (text.length <= MAX_RECORDED_BODY_CHARS) {
    return { status: response.status, body, bodyTruncated: false, downstreamId };
  }
  return {
    status: response.status,
    body: text.slice(0, MAX_RECORDED_BODY_CHARS),
    bodyTruncated: true,
    downstreamId,
  };
}
