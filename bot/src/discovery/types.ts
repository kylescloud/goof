/**
 * @file discovery/types.ts
 * @description TypeScript type definitions for the discovery module.
 */

import { ProtocolVersion } from '../config/constants';

export interface TokenMeta {
  address: string;
  symbol: string;
  decimals: number;
}

export interface PoolEntry {
  address: string;
  dex: string;
  version: ProtocolVersion;
  token0: TokenMeta;
  token1: TokenMeta;
  fee: number | null;
  stable?: boolean;        // Aerodrome Classic: true = stable pool, false = volatile pool
  tickSpacing?: number;    // Aerodrome Slipstream: tick spacing (1, 100, 200, etc.)
  aaveAsset: string;
  liquidity: string;
  sqrtPriceX96: string | null;
  tick: number | null;
  reserve0: string | null;
  reserve1: string | null;
  lastUpdatedBlock: number;
  lastUpdatedTimestamp: string;
}

export interface PoolRegistryMeta {
  chainId: number;
  lastIndexedBlock: number;
  lastUpdatedTimestamp: string;
  totalPools: number;
  aaveAssets: string[];
}

export interface PoolRegistry {
  meta: PoolRegistryMeta;
  pools: Record<string, PoolEntry>;
}

export interface DexFactoryConfig {
  dexName: string;
  factoryAddress: string;
  version: ProtocolVersion;
  deployBlock: number;
  feeTiers?: readonly number[];
  tickSpacings?: readonly number[];
}

export interface DiscoveryResult {
  totalPoolsScanned: number;
  poolsRetained: number;
  newPoolsAdded: number;
  poolsRemovedZeroLiquidity: number;
  dexBreakdown: Record<string, number>;
  duration: number;
}

export interface IncrementalUpdateResult {
  newPoolsFound: number;
  poolsUpdated: number;
  fromBlock: number;
  toBlock: number;
  duration: number;
}

export interface RawPoolData {
  address: string;
  token0: string;
  token1: string;
  fee?: number;
  stable?: boolean;        // Aerodrome Classic: true = stable pool, false = volatile pool
  tickSpacing?: number;    // Aerodrome Slipstream: tick spacing (1, 100, 200, etc.)
  dexName: string;
  version: ProtocolVersion;
}