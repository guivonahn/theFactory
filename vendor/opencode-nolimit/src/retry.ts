import { config } from "./config";

/**
 * Retry a rate-limited upstream call on the *same* model.
 *
 * Faithful to the original opencode-free-proxy: when the free tier answers
 * with 429 / an empty reply, we wait and simply try again (up to 3 attempts,
 * backoff 3s → 6s → 9s). Each attempt gets a fresh session from the caller,
 * mirroring the original repo's session rotation. No model failover.
 */
export const MAX_RETRIES = 3;
export const RETRY_BASE_MS = 3000;

export async function withRetry<T>(
  run: (attempt: number) => Promise<T>,
  label: string,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await run(attempt);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (!isRateLimitError(lastError)) throw lastError;
      if (attempt >= MAX_RETRIES - 1) break;
      const delay = RETRY_BASE_MS * (attempt + 1);
      console.log(`[${label}] rate limited (${lastError.message}), retry ${attempt + 1}/${MAX_RETRIES - 1} in ${delay}ms`);
      await Bun.sleep(delay);
    }
  }
  throw lastError ?? new Error("Rate limit exceeded");
}

/** True when an error looks like an upstream free-tier rate limit. */
export function isRateLimitError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /rate|limit|429|empty response|timed out/i.test(msg);
}
