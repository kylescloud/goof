/**
 * @file rateLimiter.ts
 * @description Token-bucket rate limiter for external API calls (primarily 0x API).
 *              Configurable requests per second. Implements an async acquire() method
 *              that resolves when a token is available.
 */

import { createModuleLogger } from './logger';

const logger = createModuleLogger('rateLimiter');

export class RateLimiter {
  private readonly maxTokens: number;
  private readonly refillRateMs: number;
  private tokens: number;
  private lastRefillTime: number;
  private waitQueue: Array<{ resolve: () => void; timestamp: number }>;
  private refillTimer: NodeJS.Timeout | null;
  private _acquireCount: number;
  private _waitCount: number;

  /**
   * Creates a new RateLimiter.
   * @param requestsPerSecond Maximum number of requests per second.
   * @param burstSize Maximum burst size (defaults to requestsPerSecond).
   */
  constructor(requestsPerSecond: number, burstSize?: number) {
    this.maxTokens = burstSize ?? requestsPerSecond;
    this.refillRateMs = 1000 / requestsPerSecond;
    this.tokens = this.maxTokens;
    this.lastRefillTime = Date.now();
    this.waitQueue = [];
    this.refillTimer = null;
    this._acquireCount = 0;
    this._waitCount = 0;

    this._startRefillLoop();
  }

  /**
   * Acquires a token from the bucket. Resolves immediately if a token is available,
   * otherwise waits until one becomes available.
   */
  async acquire(): Promise<void> {
    this._acquireCount++;
    this._refillTokens();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    this._waitCount++;
    return new Promise<void>((resolve) => {
      this.waitQueue.push({ resolve, timestamp: Date.now() });
    });
  }

  /**
   * Tries to acquire a token without waiting.
   * @returns true if a token was acquired, false otherwise.
   */
  tryAcquire(): boolean {
    this._refillTokens();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      this._acquireCount++;
      return true;
    }

    return false;
  }

  /**
   * Returns the current number of available tokens.
   */
  getAvailableTokens(): number {
    this._refillTokens();
    return Math.floor(this.tokens);
  }

  /**
   * Returns rate limiter statistics.
   */
  getStats(): { acquireCount: number; waitCount: number; availableTokens: number; queueLength: number } {
    return {
      acquireCount: this._acquireCount,
      waitCount: this._waitCount,
      availableTokens: Math.floor(this.tokens),
      queueLength: this.waitQueue.length,
    };
  }

  /**
   * Destroys the rate limiter and clears all timers.
   */
  destroy(): void {
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }

    // Resolve all waiting promises
    for (const waiter of this.waitQueue) {
      waiter.resolve();
    }
    this.waitQueue = [];
  }

  /**
   * Refills tokens based on elapsed time since last refill.
   */
  private _refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;
    const tokensToAdd = elapsed / this.refillRateMs;

    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
      this.lastRefillTime = now;
    }
  }

  /**
   * Starts the periodic refill loop that also processes the wait queue.
   */
  private _startRefillLoop(): void {
    this.refillTimer = setInterval(() => {
      this._refillTokens();
      this._processWaitQueue();
    }, Math.max(50, Math.floor(this.refillRateMs)));
  }

  /**
   * Processes the wait queue, resolving waiters when tokens are available.
   */
  private _processWaitQueue(): void {
    while (this.waitQueue.length > 0 && this.tokens >= 1) {
      const waiter = this.waitQueue.shift();
      if (waiter) {
        this.tokens -= 1;
        const waitTime = Date.now() - waiter.timestamp;
        if (waitTime > 1000) {
          logger.debug('Rate limiter wait resolved', { waitTimeMs: waitTime });
        }
        waiter.resolve();
      }
    }
  }
}