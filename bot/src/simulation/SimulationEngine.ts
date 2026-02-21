/**
 * @file SimulationEngine.ts
 * @description Orchestrates the simulation pipeline. Receives candidate paths from the StrategyEngine.
 *              For each path, runs on-chain simulation via eth_call, estimates gas, calculates net profit,
 *              and returns ranked, profitable simulation results ready for execution.
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { type Config } from '../config';
import { OnChainSimulator } from './OnChainSimulator';
import { GasEstimator } from './GasEstimator';
import { ProfitCalculator } from './ProfitCalculator';
import { OracleRegistry } from '../oracle/OracleRegistry';
import { TOKEN_BY_ADDRESS } from '../config/addresses';
import { createModuleLogger } from '../utils/logger';
import type { ArbitragePath } from '../graph/types';
import type { SimulationResult } from './types';

const logger = createModuleLogger('SimulationEngine');

export class SimulationEngine extends EventEmitter {
  private config: Config;
  private onChainSimulator: OnChainSimulator;
  private gasEstimator: GasEstimator;
  private profitCalculator: ProfitCalculator;
  private provider: ethers.Provider;
  private simulationCount: number;
  private profitableCount: number;

  constructor(
    config: Config,
    provider: ethers.Provider,
    oracleRegistry: OracleRegistry
  ) {
    super();
    this.config = config;
    this.provider = provider;
    this.simulationCount = 0;
    this.profitableCount = 0;

    this.onChainSimulator = new OnChainSimulator(provider, config.arbitrageExecutorAddress);
    this.gasEstimator = new GasEstimator(provider, oracleRegistry, config.priorityFeeGwei);
    this.profitCalculator = new ProfitCalculator(oracleRegistry, config.slippageBufferBps);
  }

  /**
   * Simulates a batch of candidate paths and returns profitable results.
   * @param candidates Array of arbitrage paths to simulate.
   * @returns Array of simulation results, sorted by net profit descending.
   */
  async simulateBatch(candidates: ArbitragePath[]): Promise<SimulationResult[]> {
    if (candidates.length === 0) return [];

    const startTime = Date.now();
    const blockNumber = await this.provider.getBlockNumber();
    const results: SimulationResult[] = [];

    logger.info('Starting simulation batch', {
      candidates: candidates.length,
      blockNumber,
    });

    // Simulate each candidate
    const promises = candidates.map((path) => this._simulatePath(path, blockNumber));
    const settled = await Promise.allSettled(promises);

    for (const result of settled) {
      if (result.status === 'fulfilled' && result.value) {
        results.push(result.value);
        this.simulationCount++;
        if (result.value.isProfitable) {
          this.profitableCount++;
        }
      }
    }

    // Filter profitable and sort by net profit
    const profitable = results
      .filter((r) => r.isProfitable && r.netProfitUsd >= this.config.minProfitThresholdUsd)
      .sort((a, b) => b.netProfitUsd - a.netProfitUsd);

    const duration = Date.now() - startTime;
    logger.info('Simulation batch complete', {
      candidates: candidates.length,
      simulated: results.length,
      profitable: profitable.length,
      duration,
    });

    // Emit profitable results
    if (profitable.length > 0) {
      this.emit('profitableOpportunities', profitable);
    }

    return profitable;
  }

  /**
   * Simulates a single arbitrage path.
   */
  private async _simulatePath(path: ArbitragePath, blockNumber: number): Promise<SimulationResult | null> {
    try {
      const tokenInfo = TOKEN_BY_ADDRESS[path.flashAsset.toLowerCase()];
      if (!tokenInfo) return null;

      // Build swap steps
      const steps = path.edges.map((edge) => ({
        dexId: edge.dexId,
        tokenIn: edge.from,
        tokenOut: edge.to,
        pool: edge.poolAddress,
        fee: edge.fee,
        minAmountOut: 0n,
        extraData: '0x',
      }));

      const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes

      // Estimate gas cost
      const gasEstimate = await this.gasEstimator.estimateGasCost(path.edges, blockNumber);

      // Check gas price limit
      if (gasEstimate.gasPriceGwei > this.config.maxGasPriceGwei) {
        logger.debug('Gas price too high, skipping', {
          gasPriceGwei: gasEstimate.gasPriceGwei,
          maxGwei: this.config.maxGasPriceGwei,
        });
        return null;
      }

      // Calculate minimum return
      const minReturn = await this.profitCalculator.calculateMinReturn(
        path.flashAmount, gasEstimate, path.flashAsset
      );

      // Run on-chain simulation
      const simResult = await this.onChainSimulator.simulate(
        path.flashAsset, path.flashAmount, steps, 0n, deadline
      );

      // Calculate profit breakdown
      const expectedReturn = simResult.isProfitable
        ? path.flashAmount + simResult.profit
        : path.expectedOutputAmount;

      const profitBreakdown = await this.profitCalculator.calculateProfit(
        path.flashAsset, path.flashAmount, expectedReturn, gasEstimate
      );

      return {
        path,
        isProfitable: profitBreakdown.isProfitable,
        simulatedProfit: profitBreakdown.grossProfitToken,
        simulatedProfitUsd: profitBreakdown.grossProfitUsd,
        gasEstimate: gasEstimate.totalGas,
        gasCostUsd: gasEstimate.gasCostUsd,
        netProfitUsd: profitBreakdown.netProfitUsd,
        flashLoanPremium: profitBreakdown.flashLoanPremium,
        totalRepayment: path.flashAmount + profitBreakdown.flashLoanPremium,
        expectedReturn,
        simulationMethod: 'on-chain',
        timestamp: Date.now(),
        blockNumber,
      };
    } catch (error) {
      logger.debug('Path simulation failed', {
        pathId: path.id,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Returns simulation engine statistics.
   */
  getStats(): { simulationCount: number; profitableCount: number; profitRate: number } {
    return {
      simulationCount: this.simulationCount,
      profitableCount: this.profitableCount,
      profitRate: this.simulationCount > 0 ? this.profitableCount / this.simulationCount : 0,
    };
  }

  /**
   * Updates the provider reference.
   */
  updateProvider(provider: ethers.Provider): void {
    this.provider = provider;
    this.onChainSimulator.updateProvider(provider);
    this.gasEstimator.updateProvider(provider);
  }
}