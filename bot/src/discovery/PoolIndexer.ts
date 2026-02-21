/**
 * @file PoolIndexer.ts
 * @description Core pool indexing logic. Iterates all DEX factory contracts. Dispatches to V2 or V3
 *              indexing logic. Batches allPairs() calls through MulticallBatcher. Batches PoolCreated
 *              event fetches in configurable block ranges. After gathering all pool addresses, multicalls
 *              each pool for token metadata. Filters by Aave asset membership.
 */

import { ethers } from 'ethers';
import { DexId, DEX_NAMES, ProtocolVersion, V2_PAIR_ABI, V3_POOL_ABI, AERODROME_POOL_ABI } from '../config/constants';
import { DEX_ADDRESSES, DEX_FACTORY_DEPLOY_BLOCKS } from '../config/addresses';
import { MulticallBatcher } from '../multicall/MulticallBatcher';
import { MulticallDecoder } from '../multicall/MulticallDecoder';
import { getTokenInfo } from '../utils/tokenUtils';
import { createModuleLogger } from '../utils/logger';
import type { RawPoolData, DexFactoryConfig } from './types';

const logger = createModuleLogger('PoolIndexer');

const V2_FACTORY_ABI = [
  'function allPairs(uint256) view returns (address)',
  'function allPairsLength() view returns (uint256)',
];

const AERODROME_FACTORY_ABI = [
  'function allPools(uint256) view returns (address)',
  'function allPoolsLength() view returns (uint256)',
];

export class PoolIndexer {
  private provider: ethers.Provider;
  private multicall: MulticallBatcher;
  private batchSize: number;
  private blockRange: number;

  constructor(provider: ethers.Provider, multicall: MulticallBatcher, batchSize: number = 200, blockRange: number = 10000) {
    this.provider = provider;
    this.multicall = multicall;
    this.batchSize = batchSize;
    this.blockRange = blockRange;
  }

  /**
   * Indexes all pools from all configured DEX factories.
   * @param aaveAssets Set of Aave flash-loanable asset addresses.
   * @returns Map of pool address -> RawPoolData for pools containing at least one Aave asset.
   */
  async indexAllPools(aaveAssets: Set<string>): Promise<Map<string, RawPoolData>> {
    const allPools = new Map<string, RawPoolData>();
    const configs = this._getFactoryConfigs();

    for (const config of configs) {
      try {
        logger.info(`Indexing ${config.dexName}`, { factory: config.factoryAddress, version: config.version });
        let pools: RawPoolData[];

        if (config.version === ProtocolVersion.V2) {
          if (config.dexName === 'Aerodrome') {
            pools = await this._indexAerodromeClassic(config);
          } else {
            pools = await this._indexV2Factory(config);
          }
        } else {
          pools = await this._indexV3Factory(config);
        }

        // Filter by Aave asset membership
        let retained = 0;
        for (const pool of pools) {
          const t0 = pool.token0.toLowerCase();
          const t1 = pool.token1.toLowerCase();
          if (aaveAssets.has(t0) || aaveAssets.has(t1)) {
            allPools.set(pool.address.toLowerCase(), pool);
            retained++;
          }
        }

        logger.info(`${config.dexName} indexing complete`, {
          totalPools: pools.length,
          retained,
        });
      } catch (error) {
        logger.error(`Failed to index ${config.dexName}`, { error: (error as Error).message });
      }
    }

    return allPools;
  }

  /**
   * Indexes a V2-style factory using allPairs() with multicall batching.
   */
  private async _indexV2Factory(config: DexFactoryConfig): Promise<RawPoolData[]> {
    const factory = new ethers.Contract(config.factoryAddress, V2_FACTORY_ABI, this.provider);
    const totalPairs = Number(await factory.allPairsLength());
    logger.info(`${config.dexName} total pairs: ${totalPairs}`);

    if (totalPairs === 0) return [];

    // Batch fetch all pair addresses
    const pairAddresses = await this._batchFetchPairAddresses(config.factoryAddress, totalPairs, 'allPairs');

    // Batch fetch token0 and token1 for each pair
    return this._batchFetchPairTokens(pairAddresses, config.dexName, config.version);
  }

  /**
   * Indexes Aerodrome classic factory using allPools().
   */
  private async _indexAerodromeClassic(config: DexFactoryConfig): Promise<RawPoolData[]> {
    const factory = new ethers.Contract(config.factoryAddress, AERODROME_FACTORY_ABI, this.provider);
    const totalPools = Number(await factory.allPoolsLength());
    logger.info(`${config.dexName} total pools: ${totalPools}`);

    if (totalPools === 0) return [];

    const poolAddresses = await this._batchFetchPairAddresses(config.factoryAddress, totalPools, 'allPools');
    return this._batchFetchPairTokens(poolAddresses, config.dexName, config.version);
  }

  /**
   * Indexes a V3-style factory using PoolCreated event logs.
   */
  private async _indexV3Factory(config: DexFactoryConfig): Promise<RawPoolData[]> {
    const currentBlock = await this.provider.getBlockNumber();
    const fromBlock = config.deployBlock;
    const pools: RawPoolData[] = [];

    // Determine the event signature based on DEX type
    let eventSignature: string;
    if (config.dexName === 'Aerodrome Slipstream') {
      eventSignature = 'PoolCreated(address,address,int24,address)';
    } else {
      eventSignature = 'PoolCreated(address,address,uint24,int24,address)';
    }
    const eventTopic = ethers.id(eventSignature);

    logger.info(`Fetching ${config.dexName} PoolCreated events`, {
      fromBlock,
      toBlock: currentBlock,
      blockRange: currentBlock - fromBlock,
    });

    // Fetch events in batches
    for (let from = fromBlock; from <= currentBlock; from += this.blockRange) {
      const to = Math.min(from + this.blockRange - 1, currentBlock);

      try {
        const logs = await this.provider.getLogs({
          address: config.factoryAddress,
          topics: [eventTopic],
          fromBlock: from,
          toBlock: to,
        });

        for (const log of logs) {
          try {
            const parsed = this._parsePoolCreatedLog(log, config);
            if (parsed) pools.push(parsed);
          } catch {
            // Skip unparseable logs
          }
        }
      } catch (error) {
        logger.warn(`Event fetch failed for block range`, {
          dex: config.dexName,
          from,
          to,
          error: (error as Error).message,
        });
        // Try smaller ranges on failure
        await this._fetchEventsSmallBatches(config, eventTopic, from, to, pools);
      }
    }

    return pools;
  }

  /**
   * Fallback: fetch events in smaller batches when large range fails.
   */
  private async _fetchEventsSmallBatches(
    config: DexFactoryConfig,
    eventTopic: string,
    fromBlock: number,
    toBlock: number,
    pools: RawPoolData[]
  ): Promise<void> {
    const smallRange = Math.floor(this.blockRange / 10);
    for (let from = fromBlock; from <= toBlock; from += smallRange) {
      const to = Math.min(from + smallRange - 1, toBlock);
      try {
        const logs = await this.provider.getLogs({
          address: config.factoryAddress,
          topics: [eventTopic],
          fromBlock: from,
          toBlock: to,
        });
        for (const log of logs) {
          try {
            const parsed = this._parsePoolCreatedLog(log, config);
            if (parsed) pools.push(parsed);
          } catch { /* skip */ }
        }
      } catch {
        logger.error(`Small batch event fetch also failed`, { from, to, dex: config.dexName });
      }
    }
  }

  /**
   * Parses a PoolCreated event log into RawPoolData.
   */
  private _parsePoolCreatedLog(log: ethers.Log, config: DexFactoryConfig): RawPoolData | null {
    if (!log.topics || log.topics.length < 3) return null;

    const token0 = ethers.getAddress('0x' + log.topics[1].slice(26));
    const token1 = ethers.getAddress('0x' + log.topics[2].slice(26));

    let poolAddress: string;
    let fee: number | undefined;

    if (config.dexName === 'Aerodrome Slipstream') {
      // PoolCreated(address token0, address token1, int24 tickSpacing, address pool)
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['int24', 'address'], log.data);
      fee = Number(decoded[0]); // tickSpacing stored as fee
      poolAddress = decoded[1] as string;
    } else {
      // PoolCreated(address token0, address token1, uint24 fee, int24 tickSpacing, address pool)
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['int24', 'address'], log.data);
      fee = Number(ethers.AbiCoder.defaultAbiCoder().decode(['uint24'], log.topics[3] || '0x')[0] || 0);
      poolAddress = decoded[1] as string;
    }

    return {
      address: poolAddress,
      token0,
      token1,
      fee,
      dexName: config.dexName,
      version: config.version,
    };
  }

  /**
   * Batch fetches pair/pool addresses from a factory using multicall.
   */
  private async _batchFetchPairAddresses(
    factoryAddress: string,
    totalCount: number,
    functionName: string
  ): Promise<string[]> {
    const addresses: string[] = [];
    const iface = new ethers.Interface([`function ${functionName}(uint256) view returns (address)`]);

    for (let i = 0; i < totalCount; i += this.batchSize) {
      const batchEnd = Math.min(i + this.batchSize, totalCount);
      const requests = [];

      for (let j = i; j < batchEnd; j++) {
        requests.push({
          target: factoryAddress,
          callData: iface.encodeFunctionData(functionName, [j]),
        });
      }

      const results = await this.multicall.call(requests);

      for (const result of results) {
        if (result.success && result.returnData !== '0x') {
          const decoded = MulticallDecoder.decodeAddress(result);
          if (decoded.success && decoded.data) {
            addresses.push(decoded.data);
          }
        }
      }
    }

    return addresses;
  }

  /**
   * Batch fetches token0 and token1 for an array of pair addresses.
   */
  private async _batchFetchPairTokens(
    pairAddresses: string[],
    dexName: string,
    version: ProtocolVersion
  ): Promise<RawPoolData[]> {
    const pools: RawPoolData[] = [];
    const token0Iface = new ethers.Interface(['function token0() view returns (address)']);
    const token1Iface = new ethers.Interface(['function token1() view returns (address)']);

    for (let i = 0; i < pairAddresses.length; i += this.batchSize) {
      const batch = pairAddresses.slice(i, i + this.batchSize);
      const requests = [];

      for (const addr of batch) {
        requests.push(
          { target: addr, callData: token0Iface.encodeFunctionData('token0') },
          { target: addr, callData: token1Iface.encodeFunctionData('token1') }
        );
      }

      const results = await this.multicall.call(requests);

      for (let j = 0; j < batch.length; j++) {
        const t0Result = MulticallDecoder.decodeAddress(results[j * 2]);
        const t1Result = MulticallDecoder.decodeAddress(results[j * 2 + 1]);

        if (t0Result.success && t1Result.success && t0Result.data && t1Result.data) {
          pools.push({
            address: batch[j],
            token0: t0Result.data,
            token1: t1Result.data,
            dexName,
            version,
          });
        }
      }
    }

    return pools;
  }

  /**
   * Returns the factory configurations for all supported DEXes.
   */
  private _getFactoryConfigs(): DexFactoryConfig[] {
    return [
      { dexName: DEX_NAMES[DexId.UNISWAP_V2], factoryAddress: DEX_ADDRESSES.uniswapV2.factory, version: ProtocolVersion.V2, deployBlock: DEX_FACTORY_DEPLOY_BLOCKS.uniswapV2 },
      { dexName: DEX_NAMES[DexId.UNISWAP_V3], factoryAddress: DEX_ADDRESSES.uniswapV3.factory, version: ProtocolVersion.V3, deployBlock: DEX_FACTORY_DEPLOY_BLOCKS.uniswapV3 },
      { dexName: DEX_NAMES[DexId.SUSHISWAP_V2], factoryAddress: DEX_ADDRESSES.sushiswapV2.factory, version: ProtocolVersion.V2, deployBlock: DEX_FACTORY_DEPLOY_BLOCKS.sushiswapV2 },
      { dexName: DEX_NAMES[DexId.SUSHISWAP_V3], factoryAddress: DEX_ADDRESSES.sushiswapV3.factory, version: ProtocolVersion.V3, deployBlock: DEX_FACTORY_DEPLOY_BLOCKS.sushiswapV3 },
      { dexName: DEX_NAMES[DexId.AERODROME], factoryAddress: DEX_ADDRESSES.aerodrome.factory, version: ProtocolVersion.V2, deployBlock: DEX_FACTORY_DEPLOY_BLOCKS.aerodrome },
      { dexName: DEX_NAMES[DexId.AERODROME_SLIPSTREAM], factoryAddress: DEX_ADDRESSES.aerodromeSlipstream.factory, version: ProtocolVersion.V3, deployBlock: DEX_FACTORY_DEPLOY_BLOCKS.aerodromeSlipstream },
      { dexName: DEX_NAMES[DexId.BASESWAP_V2], factoryAddress: DEX_ADDRESSES.baseswapV2.factory, version: ProtocolVersion.V2, deployBlock: DEX_FACTORY_DEPLOY_BLOCKS.baseswapV2 },
      { dexName: DEX_NAMES[DexId.BASESWAP_V3], factoryAddress: DEX_ADDRESSES.baseswapV3.factory, version: ProtocolVersion.V3, deployBlock: DEX_FACTORY_DEPLOY_BLOCKS.baseswapV3 },
      { dexName: DEX_NAMES[DexId.SWAPBASED], factoryAddress: DEX_ADDRESSES.swapBased.factory, version: ProtocolVersion.V2, deployBlock: DEX_FACTORY_DEPLOY_BLOCKS.swapBased },
      { dexName: DEX_NAMES[DexId.PANCAKESWAP_V3], factoryAddress: DEX_ADDRESSES.pancakeswapV3.factory, version: ProtocolVersion.V3, deployBlock: DEX_FACTORY_DEPLOY_BLOCKS.pancakeswapV3 },
    ];
  }
}