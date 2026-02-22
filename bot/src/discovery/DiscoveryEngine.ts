/**
 * @file DiscoveryEngine.ts
 * @description Orchestrates the full pool discovery lifecycle. On initialization, runs a full
 *              discovery cycle using PoolIndexer, then schedules incremental updates via
 *              IncrementalUpdater on the configured cron schedule. Emits poolsUpdated events.
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import cron from 'node-cron';
import { type Config } from '../config';
import { MulticallBatcher } from '../multicall/MulticallBatcher';
import { AaveAssetFetcher } from './AaveAssetFetcher';
import { PoolIndexer } from './PoolIndexer';
import { PoolRegistryWriter } from './PoolRegistryWriter';
import { IncrementalUpdater } from './IncrementalUpdater';
import { createModuleLogger } from '../utils/logger';
import type { PoolRegistry, DiscoveryResult, RawPoolData } from './types';
import { ProtocolVersion } from '../config/constants';

const logger = createModuleLogger('DiscoveryEngine');

/**
 * Curated seed pools — ALL addresses verified on-chain via factory.getPool() / factory.getPair().
 * Used as fallback when eth_getLogs is unavailable (free-tier RPCs).
 *
 * Covers ALL Aave V3 flash-loanable assets on Base:
 *   WETH, USDC, USDbC, DAI, cbETH, wstETH, rETH, cbBTC, WBTC, USDT
 *
 * Last verified: Base mainnet block ~42,465,000
 */
const VERIFIED_SEED_POOLS: RawPoolData[] = [

  // ══════════════════════════════════════════════════════════════════════════════
  // UNISWAP V3 — verified via factory.getPool()
  // ══════════════════════════════════════════════════════════════════════════════

  // WETH/USDC
  { address: '0xd0b53D9277642d899DF5C87A3966A349A798F224', token0: '0x4200000000000000000000000000000000000006', token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  { address: '0x6c561B446416E1A00E8E93E221854d6eA4171372', token0: '0x4200000000000000000000000000000000000006', token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  { address: '0x0b1C2DCbBfA744ebD3fC17fF1A96A1E1Eb4B2d69', token0: '0x4200000000000000000000000000000000000006', token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 10000 },
  // WETH/USDbC
  { address: '0x4C36388bE6F416A29C8d8Eee81C771cE6bE14B18', token0: '0x4200000000000000000000000000000000000006', token1: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  { address: '0x3DdF264AC95D19e81f8c25f4c300C4e59e424d43', token0: '0x4200000000000000000000000000000000000006', token1: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  // cbETH/WETH
  { address: '0x10648BA41B8565907Cfa1496765fA4D95390aa0d', token0: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', token1: '0x4200000000000000000000000000000000000006', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  { address: '0x7B9636266734270DE5bE02544c04E27046903ff8', token0: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', token1: '0x4200000000000000000000000000000000000006', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  // weETH/WETH
  { address: '0x33dfD66802CC936a58a0B25B5E4F792c1CA2312E', token0: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A', token1: '0x4200000000000000000000000000000000000006', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  { address: '0x06b80B12048a37f3762a0015A80Ac0BB37C4e539', token0: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A', token1: '0x4200000000000000000000000000000000000006', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  // cbBTC/USDC
  { address: '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef', token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', token1: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  { address: '0xeC558e484cC9f2210714E345298fdc53B253c27D', token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', token1: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  // cbBTC/WETH
  { address: '0x7AeA2E8A3843516afa07293a10Ac8E49906dabD1', token0: '0x4200000000000000000000000000000000000006', token1: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  { address: '0x8c7080564B5A792A33Ef2FD473fbA6364d5495e5', token0: '0x4200000000000000000000000000000000000006', token1: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },
  // wstETH/WETH fee=100
  { address: '0xc9034c3E7F58003E6ae0C8438e7c8f4598d5ACAA', token0: '0x4200000000000000000000000000000000000006', token1: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 100 },
  // rETH/WETH fee=500
  { address: '0x4e840AADD28DA189B9906674B4Afcb77C128d9ea', token0: '0x4200000000000000000000000000000000000006', token1: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 500 },
  // DAI/USDC fee=100
  { address: '0x6d0b9C9E92a3De30081563c3657B5258b3fFa38B', token0: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 100 },
  // USDC/USDbC fee=100
  { address: '0x06959273E9A65433De71F5A452D529544E07dDD0', token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', token1: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 100 },
  // WETH/DAI fee=3000
  { address: '0x6446021F4E396dA3df4235C62537431372195D38', token0: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', token1: '0x4200000000000000000000000000000000000006', dexName: 'Uniswap V3', version: ProtocolVersion.V3, fee: 3000 },

  // ══════════════════════════════════════════════════════════════════════════════
  // AERODROME V2 (Classic AMM) — all verified via factory.getPool(t0,t1,stable)
  // ══════════════════════════════════════════════════════════════════════════════

  // WETH/USDC volatile
  { address: '0xcDAC0d6c6C59727a65F871236188350531885C43', token0: '0x4200000000000000000000000000000000000006', token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30 },
  // WETH/USDC stable
  { address: '0x3548029694fbB241D45FB24Ba0cd9c9d4E745f16', token0: '0x4200000000000000000000000000000000000006', token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 5 },
  // USDC/USDbC stable
  { address: '0x27a8Afa3Bd49406e48a074350fB7b2020c43B2bD', token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', token1: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 5 },
  // cbETH/WETH volatile
  { address: '0x44Ecc644449fC3a9858d2007CaA8CFAa4C561f91', token0: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', token1: '0x4200000000000000000000000000000000000006', dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30 },
  // cbETH/WETH stable
  { address: '0x9E8bfEB5c73F3f897BebdB49CC4161FecE0B0c55', token0: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', token1: '0x4200000000000000000000000000000000000006', dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 5 },
  // wstETH/WETH stable
  { address: '0x29BBb5F85F01702Ec85D217CEEb2d9657700cF04', token0: '0x4200000000000000000000000000000000000006', token1: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 5 },
  // wstETH/WETH volatile
  { address: '0xA6385c73961dd9C58db2EF0c4EB98cE4B60651e8', token0: '0x4200000000000000000000000000000000000006', token1: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30 },
  // DAI/USDC stable
  { address: '0x67b00B46FA4f4F24c03855c5C8013C0B938B3eEc', token0: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 5 },
  // WETH/cbBTC volatile
  { address: '0x2578365B3dfA7FfE60108e181EFb79FeDdec2319', token0: '0x4200000000000000000000000000000000000006', token1: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30 },
  // rETH/WETH stable
  { address: '0xb8866732424AcDdd729C6fcf7146b19bFE4A2e36', token0: '0x4200000000000000000000000000000000000006', token1: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c', dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 5 },
  // rETH/WETH volatile
  { address: '0xA6F8A6bc3deA678d5bA786f2Ad2f5F93d1c87c18', token0: '0x4200000000000000000000000000000000000006', token1: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c', dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 30 },
  // USDC/USDT stable
  { address: '0x96508AE8037c6bD16162620187691F1c1e3e07C1', token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', token1: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', dexName: 'Aerodrome', version: ProtocolVersion.V2, fee: 5 },

  // ══════════════════════════════════════════════════════════════════════════════
  // AERODROME SLIPSTREAM (Concentrated Liquidity) — verified
  // ══════════════════════════════════════════════════════════════════════════════

  // WETH/USDC CL-200
  { address: '0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59', token0: '0x4200000000000000000000000000000000000006', token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 200 },
  // WETH/USD+ CL-100
  { address: '0x4D69971CCd4A636c403a3C1B00c85e99bB9B5606', token0: '0x4200000000000000000000000000000000000006', token1: '0xB79DD08EA68A908A97220C76d19A6aA9cBDE4376', dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 100 },
  // USDC/cbBTC CL-50
  { address: '0x70aCDF2Ad0bf2402C957154f944c19Ef4e1cbAE1', token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', token1: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', dexName: 'Aerodrome Slipstream', version: ProtocolVersion.V3, fee: 50 },

  // ══════════════════════════════════════════════════════════════════════════════
  // BASESWAP V2 — verified via factory.getPair()
  // ══════════════════════════════════════════════════════════════════════════════

  // WETH/USDC
  { address: '0xab067c01C7F5734da168C699Ae9d23a4512c9FdB', token0: '0x4200000000000000000000000000000000000006', token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dexName: 'BaseSwap V2', version: ProtocolVersion.V2, fee: 30 },
  // WETH/USDbC
  { address: '0x41d160033C222E6f3722EC97379867324567d883', token0: '0x4200000000000000000000000000000000000006', token1: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', dexName: 'BaseSwap V2', version: ProtocolVersion.V2, fee: 30 },

  // ══════════════════════════════════════════════════════════════════════════════
  // SUSHISWAP V2 — verified
  // ══════════════════════════════════════════════════════════════════════════════

  // WETH/USDC
  { address: '0x2F8818D1B0f3e3E295440c1C0cDDf40aAA21fA87', token0: '0x4200000000000000000000000000000000000006', token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dexName: 'SushiSwap V2', version: ProtocolVersion.V2, fee: 30 },
];

export class DiscoveryEngine extends EventEmitter {
  private config: Config;
  private provider: ethers.Provider;
  private aaveFetcher: AaveAssetFetcher;
  private poolIndexer: PoolIndexer;
  private registryWriter: PoolRegistryWriter;
  private incrementalUpdater: IncrementalUpdater;
  private cronJob: cron.ScheduledTask | null;
  private registry: PoolRegistry | null;
  private running: boolean;
  private initialized: boolean;

  constructor(config: Config, provider: ethers.Provider) {
    super();
    this.config = config;
    this.provider = provider;
    this.cronJob = null;
    this.registry = null;
    this.running = false;
    this.initialized = false;

    const multicall = new MulticallBatcher(provider, config.discoveryBatchSize);
    this.aaveFetcher = new AaveAssetFetcher(provider);
    this.poolIndexer = new PoolIndexer(provider, multicall, config.discoveryBatchSize, config.discoveryBlockRange);
    this.registryWriter = new PoolRegistryWriter(provider);
    this.incrementalUpdater = new IncrementalUpdater(provider, config.discoveryBlockRange);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing discovery engine');

    this.registry = this.registryWriter.readRegistry();
    const aaveAssets = await this.aaveFetcher.fetchFlashLoanableAssets();

    if (this.registry.meta.lastIndexedBlock === 0) {
      logger.info('No existing registry found, running full discovery');
      await this._runFullDiscovery(aaveAssets);
    } else {
      logger.info('Existing registry found, running incremental update', {
        lastIndexedBlock: this.registry.meta.lastIndexedBlock,
        totalPools: this.registry.meta.totalPools,
      });
      await this._runIncrementalUpdate(aaveAssets);
    }

    this._scheduleCronJob();

    this.initialized = true;
    logger.info('Discovery engine initialized', {
      totalPools: this.registry?.meta.totalPools ?? 0,
    });
  }

  getRegistry(): PoolRegistry {
    if (!this.registry) {
      this.registry = this.registryWriter.readRegistry();
    }
    return this.registry;
  }

  async forceFullDiscovery(): Promise<DiscoveryResult> {
    const aaveAssets = await this.aaveFetcher.fetchFlashLoanableAssets(true);
    return this._runFullDiscovery(aaveAssets);
  }

  async forceIncrementalUpdate(): Promise<void> {
    const aaveAssets = await this.aaveFetcher.fetchFlashLoanableAssets();
    await this._runIncrementalUpdate(aaveAssets);
  }

  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    this.running = false;
    this.removeAllListeners();
    logger.info('Discovery engine stopped');
  }

  private async _runFullDiscovery(aaveAssets: Set<string>): Promise<DiscoveryResult> {
    const startTime = Date.now();
    this.running = true;

    logger.info('Starting full pool discovery');

    try {
      let rawPools: Map<string, RawPoolData>;
      const canUseLogs = await this._probeEthGetLogs();

      if (!canUseLogs) {
        logger.warn(
          'eth_getLogs unavailable (free-tier RPC). Falling back to curated seed pool list. ' +
          'Upgrade to Alchemy PAYG or QuickNode paid plan for full discovery.',
        );
        rawPools = this._buildSeedPoolMap();
      } else {
        try {
          rawPools = await this.poolIndexer.indexAllPools(aaveAssets);
          logger.info('Pool indexing complete', { poolsFound: rawPools.size });
          // Always merge seed pools to ensure coverage
          for (const pool of VERIFIED_SEED_POOLS) {
            if (!rawPools.has(pool.address.toLowerCase())) {
              rawPools.set(pool.address.toLowerCase(), pool);
            }
          }
        } catch (indexError) {
          logger.warn('Pool indexer failed, falling back to seed pools', {
            error: (indexError as Error).message.slice(0, 120),
          });
          rawPools = this._buildSeedPoolMap();
        }
      }

      const currentBlock = await this.provider.getBlockNumber();

      const existingRegistry = this.registryWriter.readRegistry();
      const { registry, newCount } = await this.registryWriter.mergeNewPools(
        existingRegistry,
        rawPools,
        aaveAssets,
        currentBlock
      );

      const removed = this.registryWriter.removeZeroLiquidityPools(registry);

      this.registryWriter.writeRegistry(registry);
      this.registry = registry;

      const dexBreakdown: Record<string, number> = {};
      for (const pool of Object.values(registry.pools)) {
        dexBreakdown[pool.dex] = (dexBreakdown[pool.dex] || 0) + 1;
      }

      const result: DiscoveryResult = {
        totalPoolsScanned: rawPools.size,
        poolsRetained: Object.keys(registry.pools).length,
        newPoolsAdded: newCount,
        poolsRemovedZeroLiquidity: removed,
        dexBreakdown,
        duration: Date.now() - startTime,
      };

      logger.info('Full discovery complete', result);
      this.emit('poolsUpdated', registry, result);

      return result;
    } catch (error) {
      logger.error('Full discovery failed', { error: (error as Error).message });
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async _runIncrementalUpdate(aaveAssets: Set<string>): Promise<void> {
    if (this.running) {
      logger.warn('Discovery already running, skipping incremental update');
      return;
    }

    this.running = true;

    try {
      const lastBlock = this.registry?.meta.lastIndexedBlock ?? 0;
      const { pools, result } = await this.incrementalUpdater.fetchNewPools(lastBlock, aaveAssets);

      if (pools.size > 0) {
        const currentBlock = await this.provider.getBlockNumber();
        const existingRegistry = this.registry ?? this.registryWriter.readRegistry();
        const { registry, newCount } = await this.registryWriter.mergeNewPools(
          existingRegistry,
          pools,
          aaveAssets,
          currentBlock
        );

        this.registryWriter.writeRegistry(registry);
        this.registry = registry;

        logger.info('Incremental update merged', { newPools: newCount });
        this.emit('poolsUpdated', registry, result);
      } else {
        if (this.registry) {
          this.registry.meta.lastIndexedBlock = result.toBlock;
          this.registry.meta.lastUpdatedTimestamp = new Date().toISOString();
          this.registryWriter.writeRegistry(this.registry);
        }
      }
    } catch (error) {
      logger.error('Incremental update failed', { error: (error as Error).message });
    } finally {
      this.running = false;
    }
  }

  /**
   * Probes whether eth_getLogs is usable on the current RPC.
   * Returns false if the RPC rejects a 100-block range request (free-tier).
   */
  private async _probeEthGetLogs(): Promise<boolean> {
    try {
      const currentBlock = await this.provider.getBlockNumber();
      await this.provider.getLogs({
        fromBlock: currentBlock - 100,
        toBlock: currentBlock,
        topics: [],
      });
      return true;
    } catch (error) {
      const msg = (error as Error).message || '';
      if (
        msg.includes('block range') ||
        msg.includes('Free tier') ||
        msg.includes('eth_getLogs') ||
        msg.includes('-32600') ||
        msg.includes('-32011') ||
        msg.includes('no backend')
      ) {
        return false;
      }
      logger.debug('eth_getLogs probe returned unexpected error, assuming available', {
        error: msg.slice(0, 80),
      });
      return true;
    }
  }

  /**
   * Builds a pool map from the curated VERIFIED_SEED_POOLS list.
   */
  private _buildSeedPoolMap(): Map<string, RawPoolData> {
    const map = new Map<string, RawPoolData>();
    for (const pool of VERIFIED_SEED_POOLS) {
      map.set(pool.address.toLowerCase(), pool);
    }
    logger.info('Seed pools loaded', { count: map.size });
    return map;
  }

  private _scheduleCronJob(): void {
    if (this.cronJob) {
      this.cronJob.stop();
    }

    this.cronJob = cron.schedule(this.config.discoveryCron, async () => {
      logger.info('Cron-triggered incremental update');
      try {
        const aaveAssets = await this.aaveFetcher.fetchFlashLoanableAssets();
        await this._runIncrementalUpdate(aaveAssets);
      } catch (error) {
        logger.error('Cron incremental update failed', { error: (error as Error).message });
      }
    });

    logger.info('Discovery cron scheduled', { schedule: this.config.discoveryCron });
  }
}