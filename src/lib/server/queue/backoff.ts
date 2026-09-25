export const DEFAULT_BACKOFF_BASE_MS = 5_000;
export const DEFAULT_BACKOFF_CAP_MS = 15 * 60 * 1_000;

export interface BackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export type Backoff = (attempt: number) => number;

export function exponentialBackoff(
  attempt: number,
  {
    baseDelayMs = DEFAULT_BACKOFF_BASE_MS,
    maxDelayMs = DEFAULT_BACKOFF_CAP_MS,
  }: BackoffOptions = {}
): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}
