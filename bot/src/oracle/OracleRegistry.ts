/**
 * @file OracleRegistry.ts
 * @description Maintains a mapping of token addresses to their Chainlink feed addresses.
 *              Uses Multicall3 batching to fetch all prices in one RPC call per cycle.
 *              Falls back to hardcoded stablecoin prices and derived LST prices when feeds fail.
 *              Provides getTokenPriceUSD() and getPoolTVLUSD() by delegating to ChainlinkOracle.
 */

import { ethers } from 'ethers';
import { TOKEN_TO_FEED, TOKENS } from '../config/addresses';
import { PRECISION_18 } from '../config/constants';
import { ChainlinkOracle } from './ChainlinkOracle';
import { PriceCache } from './PriceCache';
import { fromBigInt } from '../utils/bigIntMath';
import { createModuleLogger } from '../utils/logger';
import type { TokenPriceUSD, PoolTVL } from './types';

const logger = createModuleLogger('OracleRegistry');

// ─── Hardcoded fallback prices (18-decimal BigInt) ───────────────────────────
// Used when Chainlink feeds are unavailable (e.g. rate-limited public RPC).
// These are conservative estimates — stablecoins at $1.00, ETH at last known price.
const STABLECOIN_PRICE_E18 = 10n ** 18n; // $1.00

// Tokens that are stablecoins — always use $1.00 fallback
const STABLECOIN_ADDRESSES = new Set([
  TOKENS.USDC.address.toLowerCase(),
  TOKENS.USDbC.address.toLowerCase(),
  TOKENS.USDT.address.toLowerCase(),
  TOKENS.DAI.address.toLowerCase(),
]);

// LST tokens that derive price from ETH (ratio * ETH price)
// cbETH/ETH ratio feed
const CBETH_ETH_FEED = '0x806b4Ac04501c29769051e42783cF04dCE41440b';

// Default ETH price fallback (used only if ETH/USD feed also fails)
const DEFAULT_ETH_PRICE_USD = 2000;

export class OracleRegistry {
  private oracle: ChainlinkOracle;
  private priceCache: PriceCache<bigint>;
  private tokenToFeed: Record<string, string>;
  private lastBatchFetchMs: number;
  private batchFetchIntervalMs: number;

  constructor(
    provider: ethers.Provider,
    maxStalenessSeconds: number = 86400,
    cacheTtlMs: number = 60000
  ) {
    this.oracle = new ChainlinkOracle(provider, maxStalenessSeconds);
    this.priceCache = new PriceCache<bigint>(cacheTtlMs);
    this.tokenToFeed = { ...TOKEN_TO_FEED };
    this.lastBatchFetchMs = 0;
    this.batchFetchIntervalMs = 30000; // Re-fetch all prices every 30s
  }

  /**
   * Pre-fetches all token prices in a single Multicall3 batch.
   * Call this once per block cycle to warm the cache.
   */
  async prefetchAllPrices(): Promise<void> {
    const now = Date.now();
    if (now - this.lastBatchFetchMs < this.batchFetchIntervalMs) return;
    this.lastBatchFetchMs = now;

    // Collect unique feed addresses
    const feedAddresses = [...new Set(Object.values(this.tokenToFeed))];

    // Add cbETH/ETH ratio feed
    if (!feedAddresses.includes(CBETH_ETH_FEED)) {
      feedAddresses.push(CBETH_ETH_FEED);
    }

    try {
      const batchResults = await this.oracle.getBatchPrices(feedAddresses);

      // Get ETH price first (needed for LST derivation)
      const ethFeed = this.tokenToFeed[TOKENS.WETH.address.toLowerCase()];
      const ethPriceResult = ethFeed ? batchResults.get(ethFeed.toLowerCase()) : undefined;
      const ethPriceE18 = ethPriceResult?.price ?? BigInt(Math.floor(DEFAULT_ETH_PRICE_USD * 1e18));

      // Cache prices for each token
      for (const [tokenAddrLower, feedAddr] of Object.entries(this.tokenToFeed)) {
        const result = batchResults.get(feedAddr.toLowerCase());
        if (result && !result.isStale) {
          this.priceCache.set(tokenAddrLower, result.price);
        } else if (result && result.isStale) {
          // Use stale price but with shorter TTL
          this.priceCache.set(tokenAddrLower, result.price, 10000);
        }
      }

      // Derive cbETH price from cbETH/ETH ratio * ETH price
      const cbEthRatioResult = batchResults.get(CBETH_ETH_FEED.toLowerCase());
      if (cbEthRatioResult) {
        // cbETH/ETH ratio is 18-decimal, ETH price is 18-decimal
        // cbETH USD price = ratio * ethPrice / 1e18
        const cbEthPriceE18 = (cbEthRatioResult.price * ethPriceE18) / PRECISION_18;
        this.priceCache.set(TOKENS.cbETH.address.toLowerCase(), cbEthPriceE18);
        // wstETH and rETH are roughly 1.1-1.2x ETH — use conservative 1.15x estimate
        const wstEthPriceE18 = (ethPriceE18 * 115n) / 100n;
        const rEthPriceE18   = (ethPriceE18 * 107n) / 100n;
        this.priceCache.set(TOKENS.wstETH.address.toLowerCase(), wstEthPriceE18);
        this.priceCache.set(TOKENS.rETH.address.toLowerCase(), rEthPriceE18);
      }

      logger.debug('Oracle batch prefetch complete', {
        feedsFetched: batchResults.size,
        cacheSize: this.priceCache.getStats().size,
      });
    } catch (error) {
      logger.warn('Oracle batch prefetch failed', { error: (error as Error).message.slice(0, 80) });
    }
  }

  /**
   * Gets the USD price for a token as a BigInt with 18 decimals.
   * Priority: cache → Chainlink feed → stablecoin fallback → 0n
   */
  async getTokenPriceBigInt(tokenAddress: string): Promise<bigint> {
    const key = tokenAddress.toLowerCase();

    // 1. Check cache first
    const cached = this.priceCache.get(key);
    if (cached !== undefined) return cached;

    // 2. Stablecoin fallback — always $1.00
    if (STABLECOIN_ADDRESSES.has(key)) {
      this.priceCache.set(key, STABLECOIN_PRICE_E18);
      return STABLECOIN_PRICE_E18;
    }

    // 3. Try Chainlink feed
    const feedAddress = this.tokenToFeed[key];
    if (feedAddress) {
      try {
        const batchResult = await this.oracle.getBatchPrices([feedAddress]);
        const result = batchResult.get(feedAddress.toLowerCase());
        if (result) {
          this.priceCache.set(key, result.price);
          return result.price;
        }
      } catch (error) {
        logger.debug('Chainlink feed fetch failed', {
          tokenAddress,
          error: (error as Error).message.slice(0, 60),
        });
      }
    }

    // 4. For ETH-like tokens, use ETH price as fallback
    const ethLikeTokens = new Set([
      TOKENS.WETH.address.toLowerCase(),
      TOKENS.cbETH.address.toLowerCase(),
      TOKENS.wstETH.address.toLowerCase(),
      TOKENS.rETH.address.toLowerCase(),
    ]);
    if (ethLikeTokens.has(key)) {
      const ethPrice = BigInt(Math.floor(DEFAULT_ETH_PRICE_USD * 1e18));
      this.priceCache.set(key, ethPrice, 5000); // Short TTL for fallback
      return ethPrice;
    }

    logger.debug('No price available for token', { tokenAddress });
    return 0n;
  }

  /**
   * Gets the USD price for a token as a human-readable number.
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

    // Normalize reserves to 18 decimals
    const normalizedReserve0 = decimals0 >= 18
      ? reserve0
      : reserve0 * (10n ** BigInt(18 - decimals0));
    const normalizedReserve1 = decimals1 >= 18
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
   */
  async amountToUSD(tokenAddress: string, amount: bigint, decimals: number): Promise<number> {
    const price = await this.getTokenPriceBigInt(tokenAddress);
    if (price === 0n) return 0;

    const normalizedAmount = decimals >= 18
      ? amount
      : amount * (10n ** BigInt(18 - decimals));

    return fromBigInt((normalizedAmount * price) / PRECISION_18, 18);
  }

  /**
   * Checks if a Chainlink feed exists for a token.
   */
  hasFeed(tokenAddress: string): boolean {
    return this.tokenToFeed[tokenAddress.toLowerCase()] !== undefined;
  }

  /**
   * Registers a new token-to-feed mapping.
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