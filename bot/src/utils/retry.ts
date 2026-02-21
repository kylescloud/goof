/**
 * @file retry.ts
 * @description Generic async retry utility with exponential backoff and configurable jitter.
 *              Used to wrap all RPC calls and external API interactions.
 */

import { createModuleLogger } from './logger';

const logger = createModuleLogger('retry');

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  jitterFactor?: number;
  retryableErrors?: string[];
  onRetry?: (error: Error, attempt: number) => void;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  jitterFactor: 0.3,
  retryableErrors: [],
  onRetry: () => {},
};

/**
 * Determines if an error is retryable based on the error message and configured retryable errors.
 */
function isRetryableError(error: unknown, retryableErrors: string[]): boolean {
  if (retryableErrors.length === 0) return true;

  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorCode = (error as { code?: string })?.code || '';

  return retryableErrors.some(
    (re) =>
      errorMessage.toLowerCase().includes(re.toLowerCase()) ||
      errorCode.toLowerCase().includes(re.toLowerCase())
  );
}

/**
 * Calculates the delay for the next retry attempt with exponential backoff and jitter.
 */
function calculateDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, jitterFactor: number): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  const jitter = cappedDelay * jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, Math.floor(cappedDelay + jitter));
}

/**
 * Sleeps for the specified number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps an async function with retry logic using exponential backoff with jitter.
 *
 * @param fn The async function to retry.
 * @param options Retry configuration options.
 * @returns The result of the function if it succeeds within the allowed attempts.
 * @throws The last error encountered after all retry attempts are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>
): Promise<T> {
  const opts: Required<RetryOptions> = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === opts.maxAttempts) {
        logger.error('All retry attempts exhausted', {
          attempts: opts.maxAttempts,
          error: lastError.message,
          stack: lastError.stack,
        });
        throw lastError;
      }

      if (!isRetryableError(error, opts.retryableErrors)) {
        logger.error('Non-retryable error encountered', {
          attempt,
          error: lastError.message,
        });
        throw lastError;
      }

      const delay = calculateDelay(attempt, opts.baseDelayMs, opts.maxDelayMs, opts.jitterFactor);

      logger.warn('Retrying after error', {
        attempt,
        maxAttempts: opts.maxAttempts,
        delayMs: delay,
        error: lastError.message,
      });

      opts.onRetry(lastError, attempt);

      await sleep(delay);
    }
  }

  throw lastError || new Error('Retry failed with unknown error');
}

/**
 * Creates a retry-wrapped version of an async function.
 *
 * @param fn The async function to wrap.
 * @param options Retry configuration options.
 * @returns A new function that automatically retries on failure.
 */
export function withRetryWrapper<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options?: Partial<RetryOptions>
): (...args: TArgs) => Promise<TResult> {
  return (...args: TArgs) => withRetry(() => fn(...args), options);
}