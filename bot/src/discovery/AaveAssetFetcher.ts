/**
 * @file AaveAssetFetcher.ts
 * @description Fetches the current list of Aave V3 flash-loanable assets on Base.
 *
 * Strategy:
 *   1. getReservesList() — enumerate all reserves (single call)
 *   2. Multicall3.aggregate3() — batch all getConfiguration(asset) calls into ONE
 *      RPC request, avoiding rate-limit errors that plague sequential calls.
 *   3. Decode the uint256 bitmap and check bit 63 (flashLoanEnabled).
 *
 * Why Multicall3 instead of sequential calls?
 *   The public Base RPC (and even Alchemy free tier) rate-limits sequential eth_call
 *   bursts, returning "missing revert data" errors that look like contract reverts but
 *   are actually network-level rejections. Batching into a single aggregate3() call
 *   eliminates this entirely.
 *
 * Why getConfiguration() instead of getReserveData()?
 *   getReserveData() return struct changed between Aave V3 and V3.1 (extra
 *   virtualUnderlyingBalance field), causing ABI mismatch. getConfiguration()
 *   always returns a plain uint256 bitmap — stable across all versions.
 *
 * ABI note: The return type MUST be `returns (uint256)` with NO named return and
 *   NO tuple wrapper. Any named return changes the ethers.js-computed selector,
 *   causing the contract to revert with no data.
 */

import { ethers } from 'ethers';
import { AAVE_V3, MULTICALL3 } from '../config/addresses';
import { withRetry } from '../utils/retry';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('AaveAssetFetcher');

// Bit 63 in the ReserveConfigurationMap.data field = flashLoanEnabled
const FLASHLOAN_ENABLED_BIT = 63n;

// Minimal pool ABI — only what we need
const POOL_ABI = [
  'function getReservesList() view returns (address[])',
  'function getConfiguration(address asset) view returns (uint256)',
];

// Multicall3 ABI — aggregate3 allows per-call failure tolerance
const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)',
];

// Interface used to encode getConfiguration calldata
const CONFIG_IFACE = new ethers.Interface([
  'function getConfiguration(address asset) view returns (uint256)',
]);

export class AaveAssetFetcher {
  private provider: ethers.Provider;
  private cachedAssets: Set<string>;
  private lastFetchTime: number;
  private cacheTtlMs: number;

  constructor(provider: ethers.Provider, cacheTtlMs: number = 300_000) {
    this.provider = provider;
    this.cachedAssets = new Set();
    this.lastFetchTime = 0;
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * Fetches the list of Aave V3 flash-loanable assets using Multicall3.
   * @param forceRefresh If true, bypasses the cache.
   * @returns Set of lowercase token addresses that are flash-loanable.
   */
  async fetchFlashLoanableAssets(forceRefresh: boolean = false): Promise<Set<string>> {
    if (
      !forceRefresh &&
      this.cachedAssets.size > 0 &&
      Date.now() - this.lastFetchTime < this.cacheTtlMs
    ) {
      return this.cachedAssets;
    }

    logger.info('Fetching Aave V3 flash-loanable assets');

    const pool = new ethers.Contract(AAVE_V3.pool, POOL_ABI, this.provider);
    const mc3 = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, this.provider);

    // Step 1: get the full reserves list
    const reservesList: string[] = await withRetry(
      async () => pool.getReservesList(),
      { maxAttempts: 3, baseDelayMs: 1000, retryableErrors: ['TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR'] }
    );

    logger.info('Aave reserves list fetched', { totalReserves: reservesList.length });

    // Step 2: batch all getConfiguration calls via Multicall3
    const calls = reservesList.map((asset: string) => ({
      target: AAVE_V3.pool,
      allowFailure: true,
      callData: CONFIG_IFACE.encodeFunctionData('getConfiguration', [asset]),
    }));

    const results: Array<{ success: boolean; returnData: string }> = await withRetry(
      async () => mc3.aggregate3(calls),
      { maxAttempts: 3, baseDelayMs: 1000, retryableErrors: ['TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR'] }
    );

    // Step 3: decode results and check flash-loan bit
    const flashLoanableAssets = new Set<string>();
    let skipped = 0;

    for (let i = 0; i < reservesList.length; i++) {
      const asset = reservesList[i];
      const { success, returnData } = results[i];

      if (!success || !returnData || returnData === '0x') {
        // Reserve exists in the list but getConfiguration reverted —
        // this happens for deprecated/removed reserves. Skip them.
        logger.debug('Skipping reserve — getConfiguration failed (likely deprecated)', { asset });
        skipped++;
        continue;
      }

      try {
        const configData = BigInt(returnData);
        const flashLoanEnabled = (configData >> FLASHLOAN_ENABLED_BIT) & 1n;

        if (flashLoanEnabled === 1n) {
          flashLoanableAssets.add(asset.toLowerCase());
          logger.debug('Flash loan enabled for asset', { asset });
        } else {
          logger.debug('Flash loan disabled for asset', { asset });
        }
      } catch (error) {
        logger.debug('Failed to decode configuration for asset', {
          asset,
          error: (error as Error).message,
        });
        skipped++;
      }
    }

    this.cachedAssets = flashLoanableAssets;
    this.lastFetchTime = Date.now();

    logger.info('Aave flash-loanable assets fetched', {
      totalReserves: reservesList.length,
      flashLoanable: flashLoanableAssets.size,
      skipped,
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