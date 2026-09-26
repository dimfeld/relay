import type { Integration } from "../db/repositories/integrations";
import type { DeliveryEnvelope, HttpRequest, HttpTransport } from "./types";

export const fetchTransport: HttpTransport = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
  });
  const text = await response.text();
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // Keep a non-JSON response as text so the caller can inspect it.
    }
  } else {
    body = null;
  }
  return { status: response.status, body };
};

export interface JsonPostOptions {
  integration: Integration;
  envelope: DeliveryEnvelope;
  path: string;
  body: unknown;
  transport: HttpTransport;
}

export async function postJson({
  integration,
  envelope,
  path,
  body,
  transport,
}: JsonPostOptions): Promise<unknown> {
  if (!integration.baseUrl) {
    throw new Error(`Integration "${integration.name}" has no base URL.`);
  }

  const baseUrl = integration.baseUrl.endsWith("/")
    ? integration.baseUrl
    : `${integration.baseUrl}/`;
  const request: HttpRequest = {
    method: "POST",
    url: new URL(path, baseUrl).toString(),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": envelope.idempotencyKey,
      "X-Correlation-ID": envelope.correlationId,
    },
    body: JSON.stringify(body),
  };
  const response = await transport(request);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Integration "${integration.name}" returned HTTP ${response.status} for ${envelope.actionType}.`
    );
  }
  return response.body;
}

export function responseObjectId(response: unknown, fieldName: string): string | null {
  if (!response || typeof response !== "object" || Array.isArray(response)) return null;
  const id = (response as Record<string, unknown>)[fieldName];
  return typeof id === "string" && id.trim() ? id : null;
}
