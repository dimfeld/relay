import { createHash, timingSafeEqual } from "node:crypto";
import type { AppConfig, ServiceCapability } from "../config";

export interface ServiceIdentity {
  name: string;
  capabilities: readonly ServiceCapability[];
}

type ServiceCredentials = AppConfig["INTERNAL_SERVICE_CREDENTIALS"];

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Find the service that owns the bearer token in an Authorization header. Every configured
 * token is compared, with fixed-length digests, so the time taken does not show which one matched.
 */
export function authenticateService(
  credentials: ServiceCredentials,
  authorization: string | null
): ServiceIdentity | null {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const provided = digest(match[1]);
  let identity: ServiceIdentity | null = null;
  for (const [name, credential] of Object.entries(credentials)) {
    if (timingSafeEqual(provided, digest(credential.token))) {
      identity = { name, capabilities: credential.capabilities };
    }
  }
  return identity;
}

export function hasCapability(identity: ServiceIdentity, capability: ServiceCapability): boolean {
  return identity.capabilities.includes(capability);
}
