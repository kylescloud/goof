/**
 * @file FallbackProvider.ts
 * @description Wraps multiple providers in a priority-ordered fallback chain.
 *              On RPC errors, advances to the next provider. Resets to primary
 *              after a configurable recovery window.
 */

import { ethers } from 'ethers';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('FallbackProvider');

interface ProviderEntry {
  provider: ethers.JsonRpcProvider;
  url: string;
  priority: number;
  failureCount: number;
  lastFailureTime: number;
  isHealthy: boolean;
}

export class FallbackProviderManager {
  private providers: ProviderEntry[];
  private activeIndex: number;
  private recoveryWindowMs: number;
  private maxFailuresBeforeFallback: number;
  private healthCheckInterval: NodeJS.Timeout | null;

  constructor(
    urls: string[],
    recoveryWindowMs: number = 60000,
    maxFailuresBeforeFallback: number = 3
  ) {
    this.providers = urls.map((url, index) => ({
      provider: new ethers.JsonRpcProvider(url, undefined, {
        staticNetwork: true,
        batchMaxCount: 10,
      }),
      url,
      priority: index,
      failureCount: 0,
      lastFailureTime: 0,
      isHealthy: true,
    }));

    this.activeIndex = 0;
    this.recoveryWindowMs = recoveryWindowMs;
    this.maxFailuresBeforeFallback = maxFailuresBeforeFallback;
    this.healthCheckInterval = null;

    this._startHealthCheck();
  }

  /**
   * Returns the currently active provider.
   */
  getProvider(): ethers.JsonRpcProvider {
    return this.providers[this.activeIndex].provider;
  }

  /**
   * Returns all provider instances.
   */
  getAllProviders(): ethers.JsonRpcProvider[] {
    return this.providers.map((p) => p.provider);
  }

  /**
   * Executes an RPC call with automatic fallback on failure.
   * @param fn The function to execute with a provider.
   * @returns The result of the function.
   */
  async execute<T>(fn: (provider: ethers.JsonRpcProvider) => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.providers.length; attempt++) {
      const entry = this.providers[this.activeIndex];

      try {
        const result = await fn(entry.provider);
        // Reset failure count on success
        entry.failureCount = 0;
        entry.isHealthy = true;
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        entry.failureCount++;
        entry.lastFailureTime = Date.now();

        logger.warn('Provider call failed', {
          url: entry.url,
          failureCount: entry.failureCount,
          error: lastError.message,
        });

        if (entry.failureCount >= this.maxFailuresBeforeFallback) {
          entry.isHealthy = false;
          this._advanceToNextProvider();
        }
      }
    }

    throw lastError || new Error('All providers failed');
  }

  /**
   * Reports a failure on the current provider and potentially switches.
   */
  reportFailure(): void {
    const entry = this.providers[this.activeIndex];
    entry.failureCount++;
    entry.lastFailureTime = Date.now();

    if (entry.failureCount >= this.maxFailuresBeforeFallback) {
      entry.isHealthy = false;
      this._advanceToNextProvider();
    }
  }

  /**
   * Returns the status of all providers.
   */
  getStatus(): Array<{ url: string; isHealthy: boolean; failureCount: number; isActive: boolean }> {
    return this.providers.map((entry, index) => ({
      url: entry.url,
      isHealthy: entry.isHealthy,
      failureCount: entry.failureCount,
      isActive: index === this.activeIndex,
    }));
  }

  /**
   * Destroys all providers and stops health checks.
   */
  async destroy(): Promise<void> {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    for (const entry of this.providers) {
      try {
        entry.provider.destroy();
      } catch {
        // Ignore cleanup errors
      }
    }

    logger.info('FallbackProvider destroyed');
  }

  /**
   * Advances to the next healthy provider in the list.
   */
  private _advanceToNextProvider(): void {
    const previousIndex = this.activeIndex;

    for (let i = 1; i <= this.providers.length; i++) {
      const nextIndex = (this.activeIndex + i) % this.providers.length;
      if (this.providers[nextIndex].isHealthy || nextIndex === 0) {
        this.activeIndex = nextIndex;
        break;
      }
    }

    if (this.activeIndex !== previousIndex) {
      logger.info('Switched to fallback provider', {
        from: this.providers[previousIndex].url,
        to: this.providers[this.activeIndex].url,
      });
    }
  }

  /**
   * Periodically checks if the primary provider has recovered.
   */
  private _startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      for (const entry of this.providers) {
        if (!entry.isHealthy) {
          const timeSinceFailure = Date.now() - entry.lastFailureTime;
          if (timeSinceFailure >= this.recoveryWindowMs) {
            try {
              await entry.provider.getBlockNumber();
              entry.isHealthy = true;
              entry.failureCount = 0;

              logger.info('Provider recovered', { url: entry.url });

              // If primary recovered, switch back
              if (entry.priority === 0 && this.activeIndex !== 0) {
                this.activeIndex = 0;
                logger.info('Switched back to primary provider', { url: entry.url });
              }
            } catch {
              // Still unhealthy
            }
          }
        }
      }
    }, 30000); // Check every 30 seconds
  }
}