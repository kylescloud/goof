/**
 * @file OracleRegistry.ts
 * @description Maintains a mapping of token addresses to their Chainlink feed addresses.
 *              Provides getTokenPriceUSD() and getPoolTVLUSD() by delegating to ChainlinkOracle.
 */

import { ethers } from 'ethers';
import { TOKEN_TO_FEED } from '../config/addresses';
import { PRECISION_18 } from '../config/constants';
import { ChainlinkOracle } from './ChainlinkOracle';
import { PriceCache } from './PriceCache';
import { fromBigInt } from '../utils/bigIntMath';
import { createModuleLogger } from '../utils/logger';
import type { TokenPriceUSD, PoolTVL } from './types';

const logger = createModuleLogger('OracleRegistry');

export class OracleRegistry {
  private oracle: ChainlinkOracle;
  private priceCache: PriceCache<bigint>;
  private tokenToFeed: Record<string, string>;

  constructor(provider: ethers.Provider, maxStalenessSeconds: number = 3600, cacheTtlMs: number = 30000) {
    this.oracle = new ChainlinkOracle(provider, maxStalenessSeconds);
    this.priceCache = new PriceCache<bigint>(cacheTtlMs);
    this.tokenToFeed = { ...TOKEN_TO_FEED };
  }

  /**
   * Gets the USD price for a token as a BigInt with 18 decimals.
   * @param tokenAddress The token address.
   * @returns The price with 18 decimal precision, or 0n if no feed is available.
   */
  async getTokenPriceBigInt(tokenAddress: string): Promise<bigint> {
    const key = tokenAddress.toLowerCase();
    const feedAddress = this.tokenToFeed[key];

    if (!feedAddress) {
      logger.debug('No Chainlink feed for token', { tokenAddress });
      return 0n;
    }

    return this.priceCache.getOrFetch(key, async () => {
      const oraclePrice = await this.oracle.getLatestPrice(feedAddress);
      if (oraclePrice.isStale) {
        logger.warn('Using stale price for token', { tokenAddress, updatedAt: oraclePrice.updatedAt });
      }
      return oraclePrice.price;
    });
  }

  /**
   * Gets the USD price for a token as a human-readable number.
   * @param tokenAddress The token address.
   * @returns TokenPriceUSD object.
   */
  async getTokenPriceUSD(tokenAddress: string): Promise<TokenPriceUSD> {
    const priceBigInt = await this.getTokenPriceBigInt(tokenAddress);
    const priceUsd = fromBigInt(priceBigInt, 18);

    return {
      tokenAddress,
      priceUsd,
      priceBigInt,
      timestamp: Date.now(),
    };
  }

  /**
   * Computes the TVL in USD for a pool given its reserve amounts and token addresses.
   * @param poolAddress The pool address (for identification).
   * @param token0Address Token0 address.
   * @param token1Address Token1 address.
   * @param reserve0 Reserve of token0 as BigInt.
   * @param reserve1 Reserve of token1 as BigInt.
   * @param decimals0 Decimals of token0.
   * @param decimals1 Decimals of token1.
   * @returns PoolTVL object.
   */
  async getPoolTVLUSD(
    poolAddress: string,
    token0Address: string,
    token1Address: string,
    reserve0: bigint,
    reserve1: bigint,
    decimals0: number,
    decimals1: number
  ): Promise<PoolTVL> {
    const [price0, price1] = await Promise.all([
      this.getTokenPriceBigInt(token0Address),
      this.getTokenPriceBigInt(token1Address),
    ]);

    // Normalize reserves to 18 decimals, multiply by price (18 decimals), divide by 1e18
    const normalizedReserve0 = decimals0 === 18
      ? reserve0
      : reserve0 * (10n ** BigInt(18 - decimals0));
    const normalizedReserve1 = decimals1 === 18
      ? reserve1
      : reserve1 * (10n ** BigInt(18 - decimals1));

    const token0Usd = fromBigInt((normalizedReserve0 * price0) / PRECISION_18, 18);
    const token1Usd = fromBigInt((normalizedReserve1 * price1) / PRECISION_18, 18);

    return {
      poolAddress,
      tvlUsd: token0Usd + token1Usd,
      token0Usd,
      token1Usd,
    };
  }

  /**
   * Converts a token amount to USD value.
   * @param tokenAddress The token address.
   * @param amount The token amount as BigInt.
   * @param decimals The token decimals.
   * @returns The USD value as a number.
   */
  async amountToUSD(tokenAddress: string, amount: bigint, decimals: number): Promise<number> {
    const price = await this.getTokenPriceBigInt(tokenAddress);
    if (price === 0n) return 0;

    const normalizedAmount = decimals === 18
      ? amount
      : amount * (10n ** BigInt(18 - decimals));

    return fromBigInt((normalizedAmount * price) / PRECISION_18, 18);
  }

  /**
   * Checks if a Chainlink feed exists for a token.
   * @param tokenAddress The token address.
   * @returns True if a feed is registered.
   */
  hasFeed(tokenAddress: string): boolean {
    return this.tokenToFeed[tokenAddress.toLowerCase()] !== undefined;
  }

  /**
   * Registers a new token-to-feed mapping.
   * @param tokenAddress The token address.
   * @param feedAddress The Chainlink feed address.
   */
  registerFeed(tokenAddress: string, feedAddress: string): void {
    this.tokenToFeed[tokenAddress.toLowerCase()] = feedAddress;
    logger.info('Registered Chainlink feed', { tokenAddress, feedAddress });
  }

  /**
   * Returns the price cache instance for metrics.
   */
  getPriceCache(): PriceCache<bigint> {
    return this.priceCache;
  }

  /**
   * Clears the price cache.
   */
  clearCache(): void {
    this.priceCache.clear();
  }

  /**
   * Updates the provider reference.
   */
  updateProvider(provider: ethers.Provider): void {
    this.oracle.updateProvider(provider);
  }
}