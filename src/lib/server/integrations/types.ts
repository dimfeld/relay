import type { Integration } from "../db/repositories/integrations";

export const INTEGRATION_KINDS = ["mail", "omniapp"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export interface DeliveryEnvelope<TPayload = unknown> {
  eventId: string;
  correlationId: string;
  actionType: string;
  payload: TPayload;
  idempotencyKey: string;
}

export interface OwnerDeliveryResult {
  downstreamId: string;
  response: HttpResponse;
}

export interface HttpRequest {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export interface OwnerAdapter {
  kind: IntegrationKind;
  supportedActionTypes: readonly string[];
  deliver(integration: Integration, envelope: DeliveryEnvelope): Promise<OwnerDeliveryResult>;
}
