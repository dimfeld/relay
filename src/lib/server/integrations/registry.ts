import { createMailAdapter } from "./mail";
import { createOmniAppAdapter } from "./omniapp";
import type { HttpTransport, OwnerAdapter } from "./types";

export interface IntegrationRegistry {
  getAdapter(kind: string): OwnerAdapter | null;
}

export interface IntegrationRegistryOptions {
  mailTransport?: HttpTransport;
  omniAppTransport?: HttpTransport;
}

export function createIntegrationRegistry({
  mailTransport,
  omniAppTransport,
}: IntegrationRegistryOptions = {}): IntegrationRegistry {
  const adapters = new Map<string, OwnerAdapter>([
    ["mail", createMailAdapter(mailTransport)],
    ["omniapp", createOmniAppAdapter(omniAppTransport)],
  ]);
  return { getAdapter: (kind) => adapters.get(kind) ?? null };
}
