/**
 * @file PoolRegistryWriter.ts
 * @description Handles atomic JSON file writes to data/pool_registry.json. Writes to a temp file
 *              first, then renames to the target path. Reads existing registry. Merges new pool
 *              data with existing entries. Updates meta block numbers and timestamps.
 */

import fs from 'fs';
import path from 'path';
import { CHAIN_ID } from '../config/addresses';
import { getTokenInfo } from '../utils/tokenUtils';
import { createModuleLogger } from '../utils/logger';
import type { PoolRegistry, PoolEntry, RawPoolData } from './types';
import { ethers } from 'ethers';

const logger = createModuleLogger('PoolRegistryWriter');

const REGISTRY_PATH = path.resolve(__dirname, '../../data/pool_registry.json');

export class PoolRegistryWriter {
  private provider: ethers.Provider;

  constructor(provider: ethers.Provider) {
    this.provider = provider;
  }

  /**
   * Reads the existing pool registry from disk.
   * @returns The pool registry, or a fresh empty registry if the file doesn't exist.
   */
  readRegistry(): PoolRegistry {
    try {
      if (fs.existsSync(REGISTRY_PATH)) {
        const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as PoolRegistry;
        logger.debug('Registry loaded from disk', {
          totalPools: parsed.meta.totalPools,
          lastIndexedBlock: parsed.meta.lastIndexedBlock,
        });
        return parsed;
      }
    } catch (error) {
      logger.warn('Failed to read registry, starting fresh', { error: (error as Error).message });
    }

    return this._createEmptyRegistry();
  }

  /**
   * Writes the pool registry to disk atomically (write-tmp → rename).
   * @param registry The pool registry to write.
   */
  writeRegistry(registry: PoolRegistry): void {
    const tmpPath = REGISTRY_PATH + '.tmp';

    try {
      // Ensure directory exists
      const dir = path.dirname(REGISTRY_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write to temp file
      const json = JSON.stringify(registry, null, 2);
      fs.writeFileSync(tmpPath, json, 'utf-8');

      // Atomic rename
      fs.renameSync(tmpPath, REGISTRY_PATH);

      logger.info('Registry written to disk', {
        totalPools: registry.meta.totalPools,
        lastIndexedBlock: registry.meta.lastIndexedBlock,
      });
    } catch (error) {
      logger.error('Failed to write registry', { error: (error as Error).message });

      // Clean up temp file if it exists
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch { /* ignore */ }

      throw error;
    }
  }

  /**
   * Merges new pool data into the existing registry.
   * @param existingRegistry The current registry.
   * @param newPools Map of new pool data to merge.
   * @param aaveAssets Set of Aave flash-loanable assets.
   * @param currentBlock The current block number.
   * @returns The updated registry and count of new pools added.
   */
  async mergeNewPools(
    existingRegistry: PoolRegistry,
    newPools: Map<string, RawPoolData>,
    aaveAssets: Set<string>,
    currentBlock: number
  ): Promise<{ registry: PoolRegistry; newCount: number }> {
    let newCount = 0;
    const now = new Date().toISOString();

    for (const [address, rawPool] of newPools) {
      const key = address.toLowerCase();

      if (existingRegistry.pools[key]) {
        // Update existing pool's block info
        existingRegistry.pools[key].lastUpdatedBlock = currentBlock;
        existingRegistry.pools[key].lastUpdatedTimestamp = now;
        continue;
      }

      // Determine which token is the Aave asset
      const t0Lower = rawPool.token0.toLowerCase();
      const t1Lower = rawPool.token1.toLowerCase();
      let aaveAsset = '';
      if (aaveAssets.has(t0Lower)) aaveAsset = rawPool.token0;
      else if (aaveAssets.has(t1Lower)) aaveAsset = rawPool.token1;

      // Fetch token metadata
      const [token0Info, token1Info] = await Promise.all([
        getTokenInfo(rawPool.token0, this.provider),
        getTokenInfo(rawPool.token1, this.provider),
      ]);

      const entry: PoolEntry = {
        address: rawPool.address,
        dex: rawPool.dexName,
        version: rawPool.version,
        token0: { address: token0Info.address, symbol: token0Info.symbol, decimals: token0Info.decimals },
        token1: { address: token1Info.address, symbol: token1Info.symbol, decimals: token1Info.decimals },
        fee: rawPool.fee ?? null,
        aaveAsset,
        liquidity: '0',
        sqrtPriceX96: null,
        tick: null,
        reserve0: null,
        reserve1: null,
        lastUpdatedBlock: currentBlock,
        lastUpdatedTimestamp: now,
      };

      existingRegistry.pools[key] = entry;
      newCount++;
    }

    // Update meta
    existingRegistry.meta.lastIndexedBlock = currentBlock;
    existingRegistry.meta.lastUpdatedTimestamp = now;
    existingRegistry.meta.totalPools = Object.keys(existingRegistry.pools).length;
    existingRegistry.meta.aaveAssets = Array.from(aaveAssets);

    return { registry: existingRegistry, newCount };
  }

  /**
   * Removes pools with zero liquidity from the registry.
   * @param registry The registry to clean.
   * @returns The number of pools removed.
   */
  removeZeroLiquidityPools(registry: PoolRegistry): number {
    let removed = 0;
    const keys = Object.keys(registry.pools);

    for (const key of keys) {
      const pool = registry.pools[key];
      if (pool.reserve0 === '0' && pool.reserve1 === '0' && pool.liquidity === '0') {
        delete registry.pools[key];
        removed++;
      }
    }

    if (removed > 0) {
      registry.meta.totalPools = Object.keys(registry.pools).length;
      logger.info('Removed zero-liquidity pools', { removed });
    }

    return removed;
  }

  /**
   * Creates an empty pool registry.
   */
  private _createEmptyRegistry(): PoolRegistry {
    return {
      meta: {
        chainId: CHAIN_ID,
        lastIndexedBlock: 0,
        lastUpdatedTimestamp: new Date().toISOString(),
        totalPools: 0,
        aaveAssets: [],
      },
      pools: {},
    };
  }
}