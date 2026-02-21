/**
 * @file AaveAssetFetcher.ts
 * @description Fetches the current list of Aave V3 flash-loanable assets on Base.
 *              Calls getReservesList() on the Aave V3 Pool. For each reserve, reads the
 *              flashLoanEnabled flag from the configuration bitmap. Caches results.
 */

import { ethers } from 'ethers';
import { AAVE_V3 } from '../config/addresses';
import { AAVE_V3_POOL_ABI } from '../config/constants';
import { withRetry } from '../utils/retry';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('AaveAssetFetcher');

// Bit position for flashLoanEnabled in the Aave V3 reserve configuration bitmap
// Bit 63 in the ReserveConfigurationMap data field
const FLASHLOAN_ENABLED_BIT = 63n;

export class AaveAssetFetcher {
  private provider: ethers.Provider;
  private cachedAssets: Set<string>;
  private lastFetchTime: number;
  private cacheTtlMs: number;

  constructor(provider: ethers.Provider, cacheTtlMs: number = 300000) {
    this.provider = provider;
    this.cachedAssets = new Set();
    this.lastFetchTime = 0;
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * Fetches the list of Aave V3 flash-loanable assets.
   * @param forceRefresh If true, bypasses the cache.
   * @returns Set of lowercase token addresses that are flash-loanable.
   */
  async fetchFlashLoanableAssets(forceRefresh: boolean = false): Promise<Set<string>> {
    if (!forceRefresh && this.cachedAssets.size > 0 && Date.now() - this.lastFetchTime < this.cacheTtlMs) {
      return this.cachedAssets;
    }

    logger.info('Fetching Aave V3 flash-loanable assets');

    const pool = new ethers.Contract(AAVE_V3.pool, AAVE_V3_POOL_ABI, this.provider);

    const reservesList: string[] = await withRetry(
      async () => pool.getReservesList(),
      { maxAttempts: 3, baseDelayMs: 1000, retryableErrors: ['TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR'] }
    );

    logger.info('Aave reserves list fetched', { totalReserves: reservesList.length });

    const flashLoanableAssets = new Set<string>();

    // Check each reserve for flash loan eligibility
    for (const asset of reservesList) {
      try {
        const reserveData = await withRetry(
          async () => pool.getReserveData(asset),
          { maxAttempts: 2, baseDelayMs: 500, retryableErrors: ['TIMEOUT', 'NETWORK_ERROR'] }
        );

        const configData = BigInt(reserveData.configuration.data);
        const flashLoanEnabled = (configData >> FLASHLOAN_ENABLED_BIT) & 1n;

        if (flashLoanEnabled === 1n) {
          flashLoanableAssets.add(asset.toLowerCase());
          logger.debug('Flash loan enabled for asset', { asset });
        } else {
          logger.debug('Flash loan disabled for asset', { asset });
        }
      } catch (error) {
        logger.warn('Failed to check flash loan status for asset', {
          asset,
          error: (error as Error).message,
        });
        // Include the asset anyway as a conservative approach
        flashLoanableAssets.add(asset.toLowerCase());
      }
    }

    this.cachedAssets = flashLoanableAssets;
    this.lastFetchTime = Date.now();

    logger.info('Aave flash-loanable assets fetched', {
      totalReserves: reservesList.length,
      flashLoanable: flashLoanableAssets.size,
      assets: Array.from(flashLoanableAssets),
    });

    return flashLoanableAssets;
  }

  /**
   * Checks if a token is flash-loanable.
   * @param tokenAddress The token address to check.
   * @returns True if the token is flash-loanable.
   */
  isFlashLoanable(tokenAddress: string): boolean {
    return this.cachedAssets.has(tokenAddress.toLowerCase());
  }

  /**
   * Returns the cached list of flash-loanable assets.
   */
  getCachedAssets(): string[] {
    return Array.from(this.cachedAssets);
  }

  /**
   * Updates the provider reference.
   */
  updateProvider(provider: ethers.Provider): void {
    this.provider = provider;
  }
}