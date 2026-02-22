/**
 * @file IncrementalUpdater.ts
 * @description Performs incremental pool discovery. Reads the lastIndexedBlock from the registry.
 *              Fetches only PoolCreated/PairCreated events in the range [lastIndexedBlock + 1, currentBlock].
 *              Filters new pools against the Aave asset list. Passes new pools to PoolRegistryWriter.
 */

import { ethers } from 'ethers';
import { DexId, DEX_NAMES, ProtocolVersion } from '../config/constants';
import { DEX_ADDRESSES, DEX_FACTORY_DEPLOY_BLOCKS } from '../config/addresses';
import { createModuleLogger } from '../utils/logger';
import type { RawPoolData, IncrementalUpdateResult, DexFactoryConfig } from './types';

const logger = createModuleLogger('IncrementalUpdater');

export class IncrementalUpdater {
  private provider: ethers.Provider;
  private blockRange: number;

  constructor(provider: ethers.Provider, blockRange: number = 10000) {
    this.provider = provider;
    this.blockRange = blockRange;
  }

  /**
   * Performs an incremental update from lastIndexedBlock to the current block.
   * @param lastIndexedBlock The last block that was indexed.
   * @param aaveAssets Set of Aave flash-loanable asset addresses.
   * @returns Map of new pool address -> RawPoolData and update result stats.
   */
  async fetchNewPools(
    lastIndexedBlock: number,
    aaveAssets: Set<string>
  ): Promise<{ pools: Map<string, RawPoolData>; result: IncrementalUpdateResult }> {
    const startTime = Date.now();
    const currentBlock = await this.provider.getBlockNumber();
    const fromBlock = lastIndexedBlock + 1;

    if (fromBlock > currentBlock) {
      return {
        pools: new Map(),
        result: {
          newPoolsFound: 0,
          poolsUpdated: 0,
          fromBlock,
          toBlock: currentBlock,
          duration: Date.now() - startTime,
        },
      };
    }

    logger.info('Starting incremental update', { fromBlock, toBlock: currentBlock, blockRange: currentBlock - fromBlock + 1 });

    const newPools = new Map<string, RawPoolData>();
    const configs = this._getFactoryConfigs();

    for (const config of configs) {
      try {
        const pools = await this._fetchNewPoolsForDex(config, fromBlock, currentBlock);

        for (const pool of pools) {
          const t0 = pool.token0.toLowerCase();
          const t1 = pool.token1.toLowerCase();
          if (aaveAssets.has(t0) || aaveAssets.has(t1)) {
            newPools.set(pool.address.toLowerCase(), pool);
          }
        }

        if (pools.length > 0) {
          logger.info(`${config.dexName}: found ${pools.length} new pools`);
        }
      } catch (error) {
        const errMsg = (error as Error).message || '';
        // Silently skip if RPC doesn't support eth_getLogs (free tier / public node)
        if (
          errMsg.includes('block range') ||
          errMsg.includes('Free tier') ||
          errMsg.includes('-32600') ||
          errMsg.includes('-32011') ||
          errMsg.includes('no backend')
        ) {
          logger.debug(`Incremental update skipped for ${config.dexName} — eth_getLogs unavailable on this RPC`);
          continue;
        }
        logger.error(`Incremental update failed for ${config.dexName}`, {
          error: errMsg.slice(0, 120),
        });
      }
    }

    const result: IncrementalUpdateResult = {
      newPoolsFound: newPools.size,
      poolsUpdated: 0,
      fromBlock,
      toBlock: currentBlock,
      duration: Date.now() - startTime,
    };

    logger.info('Incremental update complete', result);

    return { pools: newPools, result };
  }

  /**
   * Fetches new pools for a specific DEX factory.
   */
  private async _fetchNewPoolsForDex(
    config: DexFactoryConfig,
    fromBlock: number,
    toBlock: number
  ): Promise<RawPoolData[]> {
    const pools: RawPoolData[] = [];

    if (config.version === ProtocolVersion.V2) {
      // For V2 factories, fetch PairCreated events
      const eventSig = config.dexName === 'Aerodrome'
        ? 'PoolCreated(address,address,bool,address,uint256)'
        : 'PairCreated(address,address,address,uint256)';
      const eventTopic = ethers.id(eventSig);

      await this._fetchEventsInRange(config, eventTopic, fromBlock, toBlock, pools);
    } else {
      // For V3 factories, fetch PoolCreated events
      let eventSig: string;
      if (config.dexName === 'Aerodrome Slipstream') {
        eventSig = 'PoolCreated(address,address,int24,address)';
      } else {
        eventSig = 'PoolCreated(address,address,uint24,int24,address)';
      }
      const eventTopic = ethers.id(eventSig);

      await this._fetchEventsInRange(config, eventTopic, fromBlock, toBlock, pools);
    }

    return pools;
  }

  /**
   * Fetches events in block range batches.
   */
  private async _fetchEventsInRange(
    config: DexFactoryConfig,
    eventTopic: string,
    fromBlock: number,
    toBlock: number,
    pools: RawPoolData[]
  ): Promise<void> {
    for (let from = fromBlock; from <= toBlock; from += this.blockRange) {
      const to = Math.min(from + this.blockRange - 1, toBlock);

      try {
        const logs = await this.provider.getLogs({
          address: config.factoryAddress,
          topics: [eventTopic],
          fromBlock: from,
          toBlock: to,
        });

        for (const log of logs) {
          try {
            const parsed = this._parseEventLog(log, config);
            if (parsed) pools.push(parsed);
          } catch { /* skip unparseable */ }
        }
      } catch (error) {
        logger.warn('Event fetch failed, trying smaller batches', {
          dex: config.dexName,
          from,
          to,
          error: (error as Error).message,
        });

        // Retry with smaller range
        const smallRange = Math.floor(this.blockRange / 10);
        for (let sf = from; sf <= to; sf += smallRange) {
          const st = Math.min(sf + smallRange - 1, to);
          try {
            const logs = await this.provider.getLogs({
              address: config.factoryAddress,
              topics: [eventTopic],
              fromBlock: sf,
              toBlock: st,
            });
            for (const log of logs) {
              try {
                const parsed = this._parseEventLog(log, config);
                if (parsed) pools.push(parsed);
              } catch { /* skip */ }
            }
          } catch { /* skip failed small batch */ }
        }
      }
    }
  }

  /**
   * Parses an event log into RawPoolData.
   */
  private _parseEventLog(log: ethers.Log, config: DexFactoryConfig): RawPoolData | null {
    if (!log.topics || log.topics.length < 3) return null;

    const token0 = ethers.getAddress('0x' + log.topics[1].slice(26));
    const token1 = ethers.getAddress('0x' + log.topics[2].slice(26));

    let poolAddress: string;
    let fee: number | undefined;

    if (config.version === ProtocolVersion.V2) {
      if (config.dexName === 'Aerodrome') {
        // PoolCreated(address token0, address token1, bool stable, address pool, uint256)
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['address', 'uint256'], log.data);
        poolAddress = decoded[0] as string;
      } else {
        // PairCreated(address token0, address token1, address pair, uint256)
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['address', 'uint256'], log.data);
        poolAddress = decoded[0] as string;
      }
    } else {
      if (config.dexName === 'Aerodrome Slipstream') {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['int24', 'address'], log.data);
        fee = Number(decoded[0]);
        poolAddress = decoded[1] as string;
      } else {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['int24', 'address'], log.data);
        fee = log.topics[3] ? Number(ethers.AbiCoder.defaultAbiCoder().decode(['uint24'], log.topics[3])[0]) : undefined;
        poolAddress = decoded[1] as string;
      }
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
   * Returns factory configs for all DEXes.
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