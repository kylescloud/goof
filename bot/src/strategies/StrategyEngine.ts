/**
 * @file StrategyEngine.ts
 * @description Orchestrates all strategy modules. On each new block, runs all enabled strategies
 *              concurrently, collects results, deduplicates, ranks by estimated net profit,
 *              and emits the top opportunities for simulation.
 */

import { EventEmitter } from 'events';
import { type Config } from '../config';
import type { PoolRegistry } from '../discovery/types';
import type { TokenGraph } from '../graph/TokenGraph';
import type { DexAdapterRegistry } from '../dex/DexAdapterRegistry';
import type { OracleRegistry } from '../oracle/OracleRegistry';
import type { ArbitragePath } from '../graph/types';
import type { IStrategy, StrategyResult } from './types';
import { TwoHopCrossDex } from './TwoHopCrossDex';
import { ThreeHopTriangular } from './ThreeHopTriangular';
import { V2V3SamePairDivergence } from './V2V3SamePairDivergence';
import { StablePairExploitation } from './StablePairExploitation';
import { LiquidityImbalance } from './LiquidityImbalance';
import { ZeroXVsDirectRoute } from './ZeroXVsDirectRoute';
import { WethSandwichRoute } from './WethSandwichRoute';
import { ZeroXAdapter } from '../dex/adapters/ZeroXAdapter';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('StrategyEngine');

export class StrategyEngine extends EventEmitter {
  private config: Config;
  private strategies: IStrategy[];
  private registry: PoolRegistry;
  private graph: TokenGraph;
  private dexRegistry: DexAdapterRegistry;
  private oracleRegistry: OracleRegistry;
  private running: boolean;
  private cycleCount: number;
  private totalOpportunities: number;

  constructor(
    config: Config,
    registry: PoolRegistry,
    graph: TokenGraph,
    dexRegistry: DexAdapterRegistry,
    oracleRegistry: OracleRegistry,
    zeroXAdapter?: ZeroXAdapter
  ) {
    super();
    this.config = config;
    this.registry = registry;
    this.graph = graph;
    this.dexRegistry = dexRegistry;
    this.oracleRegistry = oracleRegistry;
    this.running = false;
    this.cycleCount = 0;
    this.totalOpportunities = 0;

    // Initialize all strategies
    const stratArgs = [config, registry, graph, dexRegistry, oracleRegistry] as const;

    const twoHop = new TwoHopCrossDex(...stratArgs, 'TwoHopCrossDex');
    const threeHop = new ThreeHopTriangular(...stratArgs, 'ThreeHopTriangular');
    const v2v3 = new V2V3SamePairDivergence(...stratArgs, 'V2V3Divergence');
    const stable = new StablePairExploitation(...stratArgs, 'StablePair');
    const liquidity = new LiquidityImbalance(...stratArgs, 'LiquidityImbalance');
    const zeroX = new ZeroXVsDirectRoute(...stratArgs, 'ZeroXVsDirect');
    const weth = new WethSandwichRoute(...stratArgs, 'WethSandwich');

    if (zeroXAdapter) {
      zeroX.setZeroXAdapter(zeroXAdapter);
    }

    this.strategies = [twoHop, threeHop, v2v3, stable, liquidity, zeroX, weth];

    logger.info('Strategy engine initialized', { strategies: this.strategies.map((s) => s.name) });
  }

  /**
   * Runs all enabled strategies concurrently and returns ranked opportunities.
   */
  async runCycle(): Promise<ArbitragePath[]> {
    if (this.running) {
      logger.warn('Strategy cycle already running, skipping');
      return [];
    }

    this.running = true;
    this.cycleCount++;
    const startTime = Date.now();

    logger.debug('Starting strategy cycle', { cycle: this.cycleCount });

    const results: StrategyResult[] = [];

    // Run all strategies concurrently
    const promises = this.strategies
      .filter((s) => s.isEnabled())
      .map(async (strategy) => {
        const stratStart = Date.now();
        try {
          const opportunities = await strategy.findOpportunities();
          return {
            strategyName: strategy.name,
            opportunities,
            duration: Date.now() - stratStart,
          } as StrategyResult;
        } catch (error) {
          logger.error(`Strategy ${strategy.name} failed`, { error: (error as Error).message });
          return {
            strategyName: strategy.name,
            opportunities: [],
            duration: Date.now() - stratStart,
            error: (error as Error).message,
          } as StrategyResult;
        }
      });

    const settledResults = await Promise.allSettled(promises);

    for (const result of settledResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      }
    }

    // Collect all opportunities
    let allOpportunities: ArbitragePath[] = [];
    for (const result of results) {
      allOpportunities.push(...result.opportunities);
      if (result.opportunities.length > 0) {
        logger.info(`${result.strategyName}: ${result.opportunities.length} opportunities (${result.duration}ms)`);
      }
    }

    // Deduplicate by path ID
    allOpportunities = this._deduplicate(allOpportunities);

    // Rank by estimated net profit
    allOpportunities.sort((a, b) => b.estimatedNetProfitUsd - a.estimatedNetProfitUsd);

    // Take top N
    const topOpportunities = allOpportunities.slice(0, 20);

    this.totalOpportunities += topOpportunities.length;
    this.running = false;

    const duration = Date.now() - startTime;
    logger.info('Strategy cycle complete', {
      cycle: this.cycleCount,
      totalFound: allOpportunities.length,
      topReturned: topOpportunities.length,
      duration,
    });

    // Emit opportunities
    if (topOpportunities.length > 0) {
      this.emit('opportunities', topOpportunities);
    }

    return topOpportunities;
  }

  /**
   * Updates the pool registry and graph for all strategies.
   */
  updateRegistry(registry: PoolRegistry): void {
    this.registry = registry;
    for (const strategy of this.strategies) {
      if ('updateRegistry' in strategy && typeof (strategy as any).updateRegistry === 'function') {
        (strategy as any).updateRegistry(registry);
      }
    }
  }

  /**
   * Returns strategy engine statistics.
   */
  getStats(): { cycleCount: number; totalOpportunities: number; strategies: string[] } {
    return {
      cycleCount: this.cycleCount,
      totalOpportunities: this.totalOpportunities,
      strategies: this.strategies.filter((s) => s.isEnabled()).map((s) => s.name),
    };
  }

  /**
   * Deduplicates opportunities by their path ID.
   */
  private _deduplicate(paths: ArbitragePath[]): ArbitragePath[] {
    const seen = new Map<string, ArbitragePath>();
    for (const path of paths) {
      const existing = seen.get(path.id);
      if (!existing || path.estimatedNetProfitUsd > existing.estimatedNetProfitUsd) {
        seen.set(path.id, path);
      }
    }
    return Array.from(seen.values());
  }
}