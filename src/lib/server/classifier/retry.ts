import { exponentialBackoff } from "../queue/backoff";
import { ProviderError } from "./types";

/*
 * These values match the default retry policy of the TypeSafe SDK (2 retries, 500 ms doubling
 * to 5 s, Retry-After honored up to 60 s). The AI SDK also defaults to 2 retries. The SDK
 * retries are turned off in the adapters so that one policy applies to both providers.
 */
export const RATE_LIMIT_MAX_RETRIES = 2;
export const RATE_LIMIT_BACKOFF = { baseDelayMs: 500, maxDelayMs: 5_000 };
export const RATE_LIMIT_MAX_RETRY_AFTER_MS = 60_000;

export interface RateLimitRetryOptions {
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retry a provider call only when it fails with HTTP 429. Other errors propagate at once. */
export async function withRateLimitRetry<T>(
  call: () => Promise<T>,
  { maxRetries = RATE_LIMIT_MAX_RETRIES, sleep = defaultSleep }: RateLimitRetryOptions = {}
): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.rateLimited || retry >= maxRetries) {
        throw error;
      }
      const delay =
        error.retryAfterMs !== undefined && error.retryAfterMs <= RATE_LIMIT_MAX_RETRY_AFTER_MS
          ? error.retryAfterMs
          : exponentialBackoff(retry + 1, RATE_LIMIT_BACKOFF);
      await sleep(delay);
    }
  }
}
