/**
 * @file PriceCache.ts
 * @description Caches oracle prices with a configurable TTL. Returns cached prices if within TTL,
 *              otherwise fetches fresh. Prevents hammering Chainlink feeds on every simulation cycle.
 *              Tracks cache hit/miss rates for metrics.
 */

import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('PriceCache');

interface CacheEntry<T> {
  value: T;
  timestamp: number;
  expiresAt: number;
}

export class PriceCache<T = bigint> {
  private cache: Map<string, CacheEntry<T>>;
  private ttlMs: number;
  private hits: number;
  private misses: number;

  constructor(ttlMs: number = 30000) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Gets a cached value if it exists and is not expired.
   * @param key The cache key.
   * @returns The cached value or undefined if not found or expired.
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }

    this.hits++;
    return entry.value;
  }

  /**
   * Sets a value in the cache.
   * @param key The cache key.
   * @param value The value to cache.
   * @param customTtlMs Optional custom TTL for this entry.
   */
  set(key: string, value: T, customTtlMs?: number): void {
    const ttl = customTtlMs ?? this.ttlMs;
    const now = Date.now();

    this.cache.set(key, {
      value,
      timestamp: now,
      expiresAt: now + ttl,
    });
  }

  /**
   * Gets a value from cache, or fetches it using the provided function if not cached.
   * @param key The cache key.
   * @param fetcher The function to call if the value is not cached.
   * @param customTtlMs Optional custom TTL for this entry.
   * @returns The cached or freshly fetched value.
   */
  async getOrFetch(key: string, fetcher: () => Promise<T>, customTtlMs?: number): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const value = await fetcher();
    this.set(key, value, customTtlMs);
    return value;
  }

  /**
   * Checks if a key exists in the cache and is not expired.
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Removes a specific key from the cache.
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clears all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
    logger.debug('Price cache cleared');
  }

  /**
   * Removes all expired entries from the cache.
   * @returns The number of entries removed.
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        pruned++;
      }
    }

    if (pruned > 0) {
      logger.debug('Price cache pruned', { entriesRemoved: pruned, remaining: this.cache.size });
    }

    return pruned;
  }

  /**
   * Returns cache statistics.
   */
  getStats(): {
    size: number;
    hits: number;
    misses: number;
    hitRate: number;
    ttlMs: number;
  } {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      ttlMs: this.ttlMs,
    };
  }

  /**
   * Resets hit/miss counters.
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Updates the default TTL.
   */
  setTtl(ttlMs: number): void {
    this.ttlMs = ttlMs;
  }
}