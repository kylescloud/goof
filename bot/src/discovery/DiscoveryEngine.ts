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
import type { PoolRegistry, DiscoveryResult } from './types';

const logger = createModuleLogger('DiscoveryEngine');

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

  /**
   * Initializes the discovery engine. Runs a full discovery if no registry exists,
   * otherwise loads from disk and schedules incremental updates.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing discovery engine');

    // Load existing registry
    this.registry = this.registryWriter.readRegistry();

    // Fetch Aave assets
    const aaveAssets = await this.aaveFetcher.fetchFlashLoanableAssets();

    if (this.registry.meta.lastIndexedBlock === 0) {
      // First run: full discovery
      logger.info('No existing registry found, running full discovery');
      await this._runFullDiscovery(aaveAssets);
    } else {
      // Incremental update from last indexed block
      logger.info('Existing registry found, running incremental update', {
        lastIndexedBlock: this.registry.meta.lastIndexedBlock,
        totalPools: this.registry.meta.totalPools,
      });
      await this._runIncrementalUpdate(aaveAssets);
    }

    // Schedule periodic incremental updates
    this._scheduleCronJob();

    this.initialized = true;
    logger.info('Discovery engine initialized', {
      totalPools: this.registry?.meta.totalPools ?? 0,
    });
  }

  /**
   * Returns the current pool registry.
   */
  getRegistry(): PoolRegistry {
    if (!this.registry) {
      this.registry = this.registryWriter.readRegistry();
    }
    return this.registry;
  }

  /**
   * Forces a full re-discovery of all pools.
   */
  async forceFullDiscovery(): Promise<DiscoveryResult> {
    const aaveAssets = await this.aaveFetcher.fetchFlashLoanableAssets(true);
    return this._runFullDiscovery(aaveAssets);
  }

  /**
   * Forces an incremental update.
   */
  async forceIncrementalUpdate(): Promise<void> {
    const aaveAssets = await this.aaveFetcher.fetchFlashLoanableAssets();
    await this._runIncrementalUpdate(aaveAssets);
  }

  /**
   * Stops the discovery engine and cleans up.
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    this.running = false;
    this.removeAllListeners();
    logger.info('Discovery engine stopped');
  }

  /**
   * Runs a full discovery cycle.
   */
  private async _runFullDiscovery(aaveAssets: Set<string>): Promise<DiscoveryResult> {
    const startTime = Date.now();
    this.running = true;

    logger.info('Starting full pool discovery');

    try {
      // Index all pools
      const rawPools = await this.poolIndexer.indexAllPools(aaveAssets);
      const currentBlock = await this.provider.getBlockNumber();

      // Merge into registry
      const existingRegistry = this.registryWriter.readRegistry();
      const { registry, newCount } = await this.registryWriter.mergeNewPools(
        existingRegistry,
        rawPools,
        aaveAssets,
        currentBlock
      );

      // Remove zero-liquidity pools
      const removed = this.registryWriter.removeZeroLiquidityPools(registry);

      // Write to disk
      this.registryWriter.writeRegistry(registry);
      this.registry = registry;

      // Build result
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

      // Emit event
      this.emit('poolsUpdated', registry, result);

      return result;
    } catch (error) {
      logger.error('Full discovery failed', { error: (error as Error).message });
      throw error;
    } finally {
      this.running = false;
    }
  }

  /**
   * Runs an incremental update.
   */
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
        // Update the lastIndexedBlock even if no new pools
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
   * Schedules the cron job for periodic incremental updates.
   */
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