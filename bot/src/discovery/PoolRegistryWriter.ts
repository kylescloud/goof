/**
 * @file PoolRegistryWriter.ts
 * @description Handles atomic JSON file writes to data/pool_registry.json. Writes to a temp file
 *              first, then renames to the target path. Reads existing registry. Merges new pool
 *              data with existing entries. Fetches on-chain state (reserves / slot0) for new pools
 *              via Multicall3 so strategies can simulate swaps immediately.
 */

import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { CHAIN_ID, MULTICALL3 } from '../config/addresses';
import { getTokenInfo } from '../utils/tokenUtils';
import { createModuleLogger } from '../utils/logger';
import { ProtocolVersion } from '../config/constants';
import type { PoolRegistry, PoolEntry, RawPoolData } from './types';

const logger = createModuleLogger('PoolRegistryWriter');

const REGISTRY_PATH = path.resolve(__dirname, '../../data/pool_registry.json');

// ─── ABIs for on-chain state fetching ────────────────────────────────────────
const V2_RESERVES_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];
const V3_SLOT0_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function tickSpacing() view returns (int24)',
];
const AERODROME_RESERVES_ABI = [
  'function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)',
  'function stable() view returns (bool)',
];
const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)',
];

// ─── Interfaces for encoding ──────────────────────────────────────────────────
const v2Iface       = new ethers.Interface(V2_RESERVES_ABI);
const v3Iface       = new ethers.Interface(V3_SLOT0_ABI);
const aeroIface     = new ethers.Interface(AERODROME_RESERVES_ABI);

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
        const raw    = fs.readFileSync(REGISTRY_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as PoolRegistry;

        // Validate and sanitize pool addresses — remove any with invalid EIP-55 checksums.
        let invalidCount = 0;
        for (const addr of Object.keys(parsed.pools)) {
          try {
            ethers.getAddress(addr);
            const pool = parsed.pools[addr];
            ethers.getAddress(pool.address);
            ethers.getAddress(pool.token0.address);
            ethers.getAddress(pool.token1.address);
          } catch {
            delete parsed.pools[addr];
            invalidCount++;
          }
        }

        if (invalidCount > 0) {
          logger.warn('Removed invalid pool addresses from registry', { invalidCount });
          parsed.meta.totalPools = Object.keys(parsed.pools).length;
          if (parsed.meta.totalPools === 0) {
            parsed.meta.lastIndexedBlock = 0;
            logger.warn('Registry was fully invalid, resetting for re-discovery');
          }
        }

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
      const dir = path.dirname(REGISTRY_PATH);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const json = JSON.stringify(registry, null, 2);
      fs.writeFileSync(tmpPath, json, 'utf-8');
      fs.renameSync(tmpPath, REGISTRY_PATH);

      logger.info('Registry written to disk', {
        totalPools: registry.meta.totalPools,
        lastIndexedBlock: registry.meta.lastIndexedBlock,
      });
    } catch (error) {
      logger.error('Failed to write registry', { error: (error as Error).message });
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch { /* ignore */ }
      throw error;
    }
  }

  /**
   * Merges new pool data into the existing registry.
   * Fetches on-chain state (reserves / slot0) for all new pools via Multicall3.
   */
  async mergeNewPools(
    existingRegistry: PoolRegistry,
    newPools: Map<string, RawPoolData>,
    aaveAssets: Set<string>,
    currentBlock: number
  ): Promise<{ registry: PoolRegistry; newCount: number }> {
    let newCount = 0;
    const now = new Date().toISOString();

    // Separate new vs existing pools
    const toAdd: RawPoolData[] = [];
    for (const [address, rawPool] of newPools) {
      const key = address.toLowerCase();
      if (existingRegistry.pools[key]) {
        existingRegistry.pools[key].lastUpdatedBlock    = currentBlock;
        existingRegistry.pools[key].lastUpdatedTimestamp = now;
      } else {
        toAdd.push(rawPool);
      }
    }

    if (toAdd.length === 0) {
      existingRegistry.meta.lastIndexedBlock    = currentBlock;
      existingRegistry.meta.lastUpdatedTimestamp = now;
      existingRegistry.meta.totalPools          = Object.keys(existingRegistry.pools).length;
      existingRegistry.meta.aaveAssets          = Array.from(aaveAssets);
      return { registry: existingRegistry, newCount: 0 };
    }

    logger.info(`Fetching on-chain state for ${toAdd.length} new pools via Multicall3`);

    // Fetch token metadata for all new pools
    const tokenAddresses = new Set<string>();
    for (const p of toAdd) {
      tokenAddresses.add(p.token0);
      tokenAddresses.add(p.token1);
    }
    const tokenInfoMap = new Map<string, { address: string; symbol: string; decimals: number }>();
    for (const addr of tokenAddresses) {
      try {
        const info = await getTokenInfo(addr, this.provider);
        tokenInfoMap.set(addr.toLowerCase(), info);
      } catch {
        tokenInfoMap.set(addr.toLowerCase(), { address: addr, symbol: addr.slice(0, 6), decimals: 18 });
      }
    }

    // Fetch on-chain state in batches of 50 via Multicall3
    const BATCH = 50;
    const onChainState = new Map<string, {
      reserve0: string | null;
      reserve1: string | null;
      sqrtPriceX96: string | null;
      liquidity: string | null;
      tick: number | null;
      stable: boolean | undefined;
      tickSpacing: number | undefined;
    }>();

    for (let i = 0; i < toAdd.length; i += BATCH) {
      const batch = toAdd.slice(i, i + BATCH);
      await this._fetchOnChainStateBatch(batch, onChainState);
    }

    // Build registry entries
    for (const rawPool of toAdd) {
      const key = rawPool.address.toLowerCase();

      // Determine Aave asset (case-insensitive)
      const t0Lower = rawPool.token0.toLowerCase();
      const t1Lower = rawPool.token1.toLowerCase();
      let aaveAsset = '';
      if (aaveAssets.has(t0Lower)) {
        // Store checksummed address
        try { aaveAsset = ethers.getAddress(rawPool.token0); } catch { aaveAsset = rawPool.token0; }
      } else if (aaveAssets.has(t1Lower)) {
        try { aaveAsset = ethers.getAddress(rawPool.token1); } catch { aaveAsset = rawPool.token1; }
      }

      const token0Info = tokenInfoMap.get(t0Lower) ?? { address: rawPool.token0, symbol: '???', decimals: 18 };
      const token1Info = tokenInfoMap.get(t1Lower) ?? { address: rawPool.token1, symbol: '???', decimals: 18 };

      const state = onChainState.get(key);

      const entry: PoolEntry = {
        address:    rawPool.address,
        dex:        rawPool.dexName,
        version:    rawPool.version,
        token0:     { address: token0Info.address, symbol: token0Info.symbol, decimals: token0Info.decimals },
        token1:     { address: token1Info.address, symbol: token1Info.symbol, decimals: token1Info.decimals },
        fee:        rawPool.fee ?? null,
        // For Aerodrome Classic: prefer on-chain stable() result, fall back to seed pool hint
        stable:     state?.stable !== undefined ? state.stable : rawPool.stable,
        // For Aerodrome Slipstream: prefer on-chain tickSpacing() result, fall back to seed pool hint
        tickSpacing: state?.tickSpacing !== undefined ? state.tickSpacing : rawPool.tickSpacing,
        aaveAsset,
        liquidity:  state?.liquidity  ?? '0',
        sqrtPriceX96: state?.sqrtPriceX96 ?? null,
        tick:       state?.tick       ?? null,
        reserve0:   state?.reserve0   ?? null,
        reserve1:   state?.reserve1   ?? null,
        lastUpdatedBlock:     currentBlock,
        lastUpdatedTimestamp: now,
      };

      existingRegistry.pools[key] = entry;
      newCount++;

      logger.debug('Pool added to registry', {
        address:  rawPool.address.slice(0, 12),
        dex:      rawPool.dexName,
        pair:     `${token0Info.symbol}/${token1Info.symbol}`,
        aaveAsset: aaveAsset ? aaveAsset.slice(0, 10) : 'none',
        reserve0: state?.reserve0  ? state.reserve0.slice(0, 12)  : 'null',
        sqrtPrice: state?.sqrtPriceX96 ? state.sqrtPriceX96.slice(0, 12) : 'null',
      });
    }

    // Update meta
    existingRegistry.meta.lastIndexedBlock    = currentBlock;
    existingRegistry.meta.lastUpdatedTimestamp = now;
    existingRegistry.meta.totalPools          = Object.keys(existingRegistry.pools).length;
    existingRegistry.meta.aaveAssets          = Array.from(aaveAssets);

    return { registry: existingRegistry, newCount };
  }

  /**
   * Removes pools with zero liquidity from the registry.
   */
  removeZeroLiquidityPools(registry: PoolRegistry): number {
    let removed = 0;
    const keys = Object.keys(registry.pools);

    for (const key of keys) {
      const pool = registry.pools[key];
      // Only remove if ALL state fields are zero/null (truly empty pool)
      const hasReserves   = pool.reserve0 && pool.reserve0 !== '0' && pool.reserve1 && pool.reserve1 !== '0';
      const hasSqrtPrice  = pool.sqrtPriceX96 && pool.sqrtPriceX96 !== '0';
      const hasLiquidity  = pool.liquidity && pool.liquidity !== '0';

      if (!hasReserves && !hasSqrtPrice && !hasLiquidity) {
        // Don't remove — pool may just not have been fetched yet
        // Only remove if explicitly marked as dead (reserve0 === '0' AND reserve1 === '0')
        if (pool.reserve0 === '0' && pool.reserve1 === '0' && pool.liquidity === '0') {
          delete registry.pools[key];
          removed++;
        }
      }
    }

    if (removed > 0) {
      registry.meta.totalPools = Object.keys(registry.pools).length;
      logger.info('Removed zero-liquidity pools', { removed });
    }

    return removed;
  }

  /**
   * Fetches on-chain state (reserves or slot0) for a batch of pools via Multicall3.
   */
  private async _fetchOnChainStateBatch(
    pools: RawPoolData[],
    stateMap: Map<string, {
      reserve0: string | null;
      reserve1: string | null;
      sqrtPriceX96: string | null;
      liquidity: string | null;
      tick: number | null;
      stable: boolean | undefined;
      tickSpacing: number | undefined;
    }>
  ): Promise<void> {
    try {
      const multicall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, this.provider);

      // Build calls: for V2 pools call getReserves(), for V3 pools call slot0() + liquidity()
      // For Aerodrome Classic pools also call stable()
      // For Aerodrome Slipstream pools also call tickSpacing()
      const calls: { target: string; allowFailure: boolean; callData: string }[] = [];
      const callIndex: { poolIdx: number; type: 'v2reserves' | 'v3slot0' | 'v3liquidity' | 'aeroreserves' | 'aerostable' | 'v3tickspacing' }[] = [];

      for (let i = 0; i < pools.length; i++) {
        const pool = pools[i];
        const addr = pool.address;

        if (pool.version === ProtocolVersion.V2) {
          if (pool.dexName === 'Aerodrome') {
            // Aerodrome returns uint256 reserves
            calls.push({ target: addr, allowFailure: true, callData: aeroIface.encodeFunctionData('getReserves') });
            callIndex.push({ poolIdx: i, type: 'aeroreserves' });
            // Also fetch stable() flag
            calls.push({ target: addr, allowFailure: true, callData: aeroIface.encodeFunctionData('stable') });
            callIndex.push({ poolIdx: i, type: 'aerostable' });
          } else {
            // Standard Uniswap V2 style
            calls.push({ target: addr, allowFailure: true, callData: v2Iface.encodeFunctionData('getReserves') });
            callIndex.push({ poolIdx: i, type: 'v2reserves' });
          }
        } else {
          // V3: fetch slot0 and liquidity
          calls.push({ target: addr, allowFailure: true, callData: v3Iface.encodeFunctionData('slot0') });
          callIndex.push({ poolIdx: i, type: 'v3slot0' });
          calls.push({ target: addr, allowFailure: true, callData: v3Iface.encodeFunctionData('liquidity') });
          callIndex.push({ poolIdx: i, type: 'v3liquidity' });
          // For Aerodrome Slipstream, also fetch tickSpacing()
          if (pool.dexName === 'Aerodrome Slipstream') {
            calls.push({ target: addr, allowFailure: true, callData: v3Iface.encodeFunctionData('tickSpacing') });
            callIndex.push({ poolIdx: i, type: 'v3tickspacing' });
          }
        }
      }

      if (calls.length === 0) return;

      const results: { success: boolean; returnData: string }[] = await multicall.aggregate3(calls);

      // Initialize state for all pools
      for (const pool of pools) {
        stateMap.set(pool.address.toLowerCase(), {
          reserve0: null, reserve1: null,
          sqrtPriceX96: null, liquidity: null, tick: null,
          stable: undefined, tickSpacing: undefined,
        });
      }

      // Parse results
      for (let ci = 0; ci < results.length; ci++) {
        const { success, returnData } = results[ci];
        const { poolIdx, type } = callIndex[ci];
        const pool = pools[poolIdx];
        const key  = pool.address.toLowerCase();
        const state = stateMap.get(key)!;

        if (!success || !returnData || returnData === '0x') continue;

        try {
          if (type === 'v2reserves') {
            const decoded = v2Iface.decodeFunctionResult('getReserves', returnData);
            state.reserve0 = decoded[0].toString();
            state.reserve1 = decoded[1].toString();
          } else if (type === 'aeroreserves') {
            const decoded = aeroIface.decodeFunctionResult('getReserves', returnData);
            state.reserve0 = decoded[0].toString();
            state.reserve1 = decoded[1].toString();
          } else if (type === 'aerostable') {
            const decoded = aeroIface.decodeFunctionResult('stable', returnData);
            state.stable = Boolean(decoded[0]);
          } else if (type === 'v3slot0') {
            const decoded = v3Iface.decodeFunctionResult('slot0', returnData);
            state.sqrtPriceX96 = decoded[0].toString();
            state.tick         = Number(decoded[1]);
          } else if (type === 'v3liquidity') {
            const decoded = v3Iface.decodeFunctionResult('liquidity', returnData);
            state.liquidity = decoded[0].toString();
          } else if (type === 'v3tickspacing') {
            const decoded = v3Iface.decodeFunctionResult('tickSpacing', returnData);
            state.tickSpacing = Number(decoded[0]);
          }
        } catch (decodeErr) {
          logger.debug('Failed to decode pool state', {
            pool: pool.address.slice(0, 12),
            type,
            error: (decodeErr as Error).message.slice(0, 60),
          });
        }
      }

      const fetched = [...stateMap.values()].filter(s =>
        s.reserve0 !== null || s.sqrtPriceX96 !== null
      ).length;
      logger.info(`On-chain state fetched for ${fetched}/${pools.length} pools`);

    } catch (error) {
      logger.warn('Multicall3 batch state fetch failed, pools will have null state', {
        error: (error as Error).message.slice(0, 100),
      });
    }
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