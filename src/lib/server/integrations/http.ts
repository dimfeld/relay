import type { Integration } from "../db/repositories/integrations";
import type { DeliveryEnvelope, HttpRequest, HttpResponse, HttpTransport } from "./types";

/**
 * A delivery failure that carries retry guidance and, when the owner answered, its response.
 * Errors of any other type are treated as permanent.
 */
export class DeliveryError extends Error {
  readonly transient: boolean;
  readonly response: HttpResponse | null;

  constructor(
    message: string,
    { transient, response = null }: { transient: boolean; response?: HttpResponse | null }
  ) {
    super(message);
    this.name = "DeliveryError";
    this.transient = transient;
    this.response = response;
  }
}

/** Timeouts, rate limits, and server errors can succeed later; other statuses cannot. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

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
}: JsonPostOptions): Promise<HttpResponse> {
  return sendRequest(
    integration,
    {
      method: "POST",
      url: integrationUrl(integration, path),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": envelope.idempotencyKey,
        "X-Correlation-ID": envelope.correlationId,
      },
      body: JSON.stringify(body),
    },
    envelope.actionType,
    transport
  );
}

export interface JsonGetOptions {
  integration: Integration;
  path: string;
  correlationId: string;
  transport: HttpTransport;
}

export async function getJson({
  integration,
  path,
  correlationId,
  transport,
}: JsonGetOptions): Promise<HttpResponse> {
  return sendRequest(
    integration,
    {
      method: "GET",
      url: integrationUrl(integration, path),
      headers: { Accept: "application/json", "X-Correlation-ID": correlationId },
    },
    `GET ${path}`,
    transport
  );
}

function integrationUrl(integration: Integration, path: string): string {
  if (!integration.baseUrl) {
    throw new Error(`Integration "${integration.name}" has no base URL.`);
  }
  const baseUrl = integration.baseUrl.endsWith("/")
    ? integration.baseUrl
    : `${integration.baseUrl}/`;
  return new URL(path, baseUrl).toString();
}

async function sendRequest(
  integration: Integration,
  request: HttpRequest,
  operation: string,
  transport: HttpTransport
): Promise<HttpResponse> {
  let response: HttpResponse;
  try {
    response = await transport(request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DeliveryError(
      `Integration "${integration.name}" request failed for ${operation}: ${reason}`,
      { transient: true }
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new DeliveryError(
      `Integration "${integration.name}" returned HTTP ${response.status} for ${operation}.`,
      { transient: isTransientStatus(response.status), response }
    );
  }
  return response;
}

export function responseObjectId(body: unknown, fieldName: string): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const id = (body as Record<string, unknown>)[fieldName];
  return typeof id === "string" && id.trim() ? id : null;
}

/** Return the owner's object ID, or fail permanently: a retry does not fix the response shape. */
export function requireObjectId(
  response: HttpResponse,
  fieldName: string,
  message: string
): string {
  const id = responseObjectId(response.body, fieldName);
  if (!id) throw new DeliveryError(message, { transient: false, response });
  return id;
}
