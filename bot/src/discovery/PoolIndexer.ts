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
import { getTokenInfo } from '../utils/tokenUtils';
import { createModuleLogger } from '../utils/logger';
import type { RawPoolData, DexFactoryConfig } from './types';

const logger = createModuleLogger('PoolIndexer');



// Delay between block-range event fetches to avoid rate-limiting on public RPCs (ms)
const INTER_BATCH_DELAY_MS = 50;

export class PoolIndexer {
  private provider: ethers.Provider;
  private multicall: MulticallBatcher;
  private batchSize: number;
  private blockRange: number;

  constructor(provider: ethers.Provider, multicall: MulticallBatcher, batchSize: number = 50, blockRange: number = 10000) {
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
   * Indexes a V2-style factory using PairCreated event logs filtered by Aave assets.
   *
   * Why events instead of allPairs() enumeration?
   *   - allPairs() on Uniswap V2 Base returns 2.8M+ pairs — fetching them all via
   *     multicall is impractical and overwhelms public RPCs.
   *   - eth_getLogs with topic filters returns ONLY pairs that contain at least one
   *     Aave flash-loanable asset, which is exactly what we need for arbitrage.
   *   - This reduces the result set from millions to hundreds of relevant pools.
   *
   * PairCreated(address indexed token0, address indexed token1, address pair, uint256)
   */
  private async _indexV2Factory(config: DexFactoryConfig): Promise<RawPoolData[]> {
    const currentBlock = await this.provider.getBlockNumber();
    const fromBlock = config.deployBlock;

    // PairCreated event topic
    const eventTopic = ethers.id('PairCreated(address,address,address,uint256)');

    logger.info(`Fetching ${config.dexName} PairCreated events`, {
      fromBlock,
      toBlock: currentBlock,
      blockRange: currentBlock - fromBlock,
    });

    const pools: RawPoolData[] = [];

    // Fetch events in block range batches
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
            // PairCreated: topics[1]=token0, topics[2]=token1, data=pair+index
            const token0 = ethers.getAddress('0x' + log.topics[1].slice(26));
            const token1 = ethers.getAddress('0x' + log.topics[2].slice(26));
            const pairAddress = ethers.getAddress('0x' + log.data.slice(26, 66));

            pools.push({
              address: pairAddress,
              token0,
              token1,
              dexName: config.dexName,
              version: config.version,
            });
          } catch {
            // Skip unparseable logs
          }
        }
      } catch (error) {
        logger.warn(`PairCreated event fetch failed for block range`, {
          dex: config.dexName,
          from,
          to,
          error: (error as Error).message,
        });
        // Try smaller ranges on failure
        await this._fetchV2EventsSmallBatches(config, eventTopic, from, to, pools);
      }

      // Small delay between block range fetches to avoid rate limiting
      if (from + this.blockRange <= currentBlock) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    logger.info(`${config.dexName} indexed via events`, { totalPools: pools.length });
    return pools;
  }

  /**
   * Indexes Aerodrome classic factory using PoolCreated event logs.
   * Aerodrome: PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)
   */
  private async _indexAerodromeClassic(config: DexFactoryConfig): Promise<RawPoolData[]> {
    const currentBlock = await this.provider.getBlockNumber();
    const fromBlock = config.deployBlock;

    // Aerodrome PoolCreated event
    const eventTopic = ethers.id('PoolCreated(address,address,bool,address,uint256)');

    logger.info(`Fetching ${config.dexName} PoolCreated events`, {
      fromBlock,
      toBlock: currentBlock,
    });

    const pools: RawPoolData[] = [];

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
            // topics[1]=token0, topics[2]=token1, topics[3]=stable, data=pool+index
            const token0 = ethers.getAddress('0x' + log.topics[1].slice(26));
            const token1 = ethers.getAddress('0x' + log.topics[2].slice(26));
            const poolAddress = ethers.getAddress('0x' + log.data.slice(26, 66));

            pools.push({
              address: poolAddress,
              token0,
              token1,
              dexName: config.dexName,
              version: config.version,
            });
          } catch {
            // Skip unparseable logs
          }
        }
      } catch (error) {
        logger.warn(`Aerodrome PoolCreated event fetch failed`, {
          dex: config.dexName,
          from,
          to,
          error: (error as Error).message,
        });
      }

      if (from + this.blockRange <= currentBlock) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    logger.info(`${config.dexName} indexed via events`, { totalPools: pools.length });
    return pools;
  }

  /**
   * Fallback: fetch V2 PairCreated events in smaller block ranges when the main range fails.
   */
  private async _fetchV2EventsSmallBatches(
    config: DexFactoryConfig,
    eventTopic: string,
    from: number,
    to: number,
    pools: RawPoolData[]
  ): Promise<void> {
    const smallRange = Math.floor(this.blockRange / 10);
    for (let f = from; f <= to; f += smallRange) {
      const t = Math.min(f + smallRange - 1, to);
      try {
        const logs = await this.provider.getLogs({
          address: config.factoryAddress,
          topics: [eventTopic],
          fromBlock: f,
          toBlock: t,
        });
        for (const log of logs) {
          try {
            const token0 = ethers.getAddress('0x' + log.topics[1].slice(26));
            const token1 = ethers.getAddress('0x' + log.topics[2].slice(26));
            const pairAddress = ethers.getAddress('0x' + log.data.slice(26, 66));
            pools.push({ address: pairAddress, token0, token1, dexName: config.dexName, version: config.version });
          } catch { /* skip */ }
        }
      } catch (error) {
        logger.debug(`Small batch V2 event fetch failed`, { from: f, to: t, error: (error as Error).message });
      }
    }
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