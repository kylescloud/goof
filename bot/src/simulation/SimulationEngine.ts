/**
 * @file SimulationEngine.ts
 * @description Orchestrates the simulation pipeline. Receives candidate paths from the StrategyEngine.
 *              For each path, runs on-chain simulation via eth_call (if contract deployed), estimates
 *              gas, calculates net profit, and returns ranked, profitable simulation results.
 *
 *              IMPORTANT: If ARBITRAGE_EXECUTOR_ADDRESS is zero (contract not deployed), the engine
 *              falls back to off-chain math only and marks results as UNVERIFIED. These results are
 *              logged but NOT sent to ExecutionEngine.
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { type Config } from '../config';
import { OnChainSimulator } from './OnChainSimulator';
import { GasEstimator } from './GasEstimator';
import { ProfitCalculator } from './ProfitCalculator';
import { OracleRegistry } from '../oracle/OracleRegistry';
import { TOKEN_BY_ADDRESS } from '../config/addresses';
import { FLASH_LOAN_PREMIUM_BPS, FLASH_LOAN_PREMIUM_DIVISOR } from '../config/constants';
import { fromBigInt } from '../utils/bigIntMath';
import { getAmountOut as v2GetAmountOut } from '../dex/math/V2Math';
import { createModuleLogger } from '../utils/logger';
import type { ArbitragePath, GraphEdge } from '../graph/types';
import type { SimulationResult } from './types';

const logger = createModuleLogger('SimulationEngine');

// Maximum realistic profit as a fraction of flash loan amount (50%)
// Anything above this is almost certainly a math/oracle error
const MAX_PROFIT_FRACTION = 0.5;

// Zero address constant
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export class SimulationEngine extends EventEmitter {
  private config: Config;
  private onChainSimulator: OnChainSimulator;
  private gasEstimator: GasEstimator;
  private profitCalculator: ProfitCalculator;
  private provider: ethers.Provider;
  private simulationCount: number;
  private profitableCount: number;
  private contractDeployed: boolean;

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

    // Check if contract is deployed
    this.contractDeployed = (
      !!config.arbitrageExecutorAddress &&
      config.arbitrageExecutorAddress !== ZERO_ADDRESS &&
      config.arbitrageExecutorAddress.length === 42
    );

    if (!this.contractDeployed) {
      logger.warn(
        '⚠️  ArbitrageExecutor contract not deployed — running in OFF-CHAIN SIMULATION ONLY mode. ' +
        'Profitable opportunities will be logged but NOT executed. ' +
        'Deploy the contract and set ARBITRAGE_EXECUTOR_ADDRESS to enable execution.'
      );
    }

    this.onChainSimulator = new OnChainSimulator(provider, config.arbitrageExecutorAddress || ZERO_ADDRESS);
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

    logger.debug('Starting simulation batch', {
      candidates: candidates.length,
      blockNumber,
      mode: this.contractDeployed ? 'on-chain' : 'off-chain-only',
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

    // Only emit for execution if contract is deployed
    if (profitable.length > 0) {
      if (this.contractDeployed) {
        this.emit('profitableOpportunities', profitable);
      } else {
        logger.info(
          `🔍 [DRY-RUN] Found ${profitable.length} profitable opportunities (contract not deployed — not executing)`,
          {
            best: profitable[0]
              ? `$${profitable[0].netProfitUsd.toFixed(4)} net profit`
              : 'none',
          }
        );
      }
    }

    // Return empty array if contract not deployed — prevents ExecutionEngine from running
    return this.contractDeployed ? profitable : [];
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

      const deadline = Math.floor(Date.now() / 1000) + 300;

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

      let expectedReturn: bigint;
      let simulationMethod: 'on-chain' | 'local' | 'off-chain-unverified';

      if (this.contractDeployed) {
        // ── On-chain simulation via eth_call ──────────────────────────────────
        const simResult = await this.onChainSimulator.simulate(
          path.flashAsset, path.flashAmount, steps, 0n, deadline
        );

        if (simResult.isProfitable) {
          expectedReturn = path.flashAmount + simResult.profit;
          simulationMethod = 'on-chain';
        } else {
          // On-chain says not profitable — trust it
          return null;
        }
      } else {
        // ── Off-chain math only (contract not deployed) ───────────────────────
        // Use the expectedOutputAmount from strategy math
        expectedReturn = path.expectedOutputAmount;
        simulationMethod = 'off-chain-unverified';
      }

      // ── Sanity check: profit can't exceed MAX_PROFIT_FRACTION of flash amount ──
      const premium = (path.flashAmount * FLASH_LOAN_PREMIUM_BPS) / FLASH_LOAN_PREMIUM_DIVISOR;
      const totalRepayment = path.flashAmount + premium;

      if (expectedReturn <= totalRepayment) {
        return null; // Not profitable after repayment
      }

      const grossProfitToken = expectedReturn - totalRepayment;

      // Sanity cap: gross profit token amount can't exceed MAX_PROFIT_FRACTION of flash amount
      const maxReasonableProfit = (path.flashAmount * BigInt(Math.floor(MAX_PROFIT_FRACTION * 10000))) / 10000n;
      if (grossProfitToken > maxReasonableProfit) {
        logger.warn('Profit exceeds sanity cap — likely oracle/math error, skipping', {
          pathId: path.id,
          flashAmount: fromBigInt(path.flashAmount, tokenInfo.decimals).toFixed(4),
          grossProfitToken: fromBigInt(grossProfitToken, tokenInfo.decimals).toFixed(4),
          maxReasonable: fromBigInt(maxReasonableProfit, tokenInfo.decimals).toFixed(4),
          simulationMethod,
        });
        return null;
      }

      // Calculate profit breakdown
      const profitBreakdown = await this.profitCalculator.calculateProfit(
        path.flashAsset, path.flashAmount, expectedReturn, gasEstimate
      );

      // Additional USD sanity check: net profit can't exceed $500k per trade
      if (profitBreakdown.netProfitUsd > 500_000) {
        logger.warn('Net profit USD exceeds sanity cap — likely oracle error, skipping', {
          pathId: path.id,
          netProfitUsd: profitBreakdown.netProfitUsd.toFixed(2),
          simulationMethod,
        });
        return null;
      }

      // Compute per-step output amounts for per-step minAmountOut in TransactionBuilder
      const stepOutputs = this._computeStepOutputs(path.edges, path.flashAmount);

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
        simulationMethod,
        stepOutputs,
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
   * Returns whether the contract is deployed and execution is enabled.
   */
  isContractDeployed(): boolean {
    return this.contractDeployed;
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

  /**
   * Computes per-step simulated output amounts using local AMM math.
   * Used by TransactionBuilder to set per-step minAmountOut (1% slippage buffer).
   */
  private _computeStepOutputs(edges: GraphEdge[], flashAmount: bigint): bigint[] {
    const outputs: bigint[] = [];
    let currentAmount = flashAmount;

    for (const edge of edges) {
      try {
        let amountOut = 0n;

        if (edge.reserve0 && edge.reserve1 && edge.reserve0 > 0n && edge.reserve1 > 0n) {
          // V2 AMM math
          const isToken0In = edge.from.toLowerCase() < edge.to.toLowerCase();
          const reserveIn  = isToken0In ? edge.reserve0 : edge.reserve1;
          const reserveOut = isToken0In ? edge.reserve1 : edge.reserve0;
          const feeBps = Math.round((edge.fee / 1_000_000) * 10_000); // ppm → bps
          amountOut = v2GetAmountOut(currentAmount, reserveIn, reserveOut, feeBps);
        } else if (edge.sqrtPriceX96 && edge.sqrtPriceX96 > 0n) {
          // V3 single-tick approximation
          const feePpm = BigInt(edge.fee);
          const feeMultiplier = 1_000_000n - feePpm;
          const amountInAfterFee = (currentAmount * feeMultiplier) / 1_000_000n;
          const zeroForOne = edge.from.toLowerCase() < edge.to.toLowerCase();

          if (zeroForOne) {
            const priceNum = edge.sqrtPriceX96 * edge.sqrtPriceX96;
            amountOut = (amountInAfterFee * priceNum) >> 192n;
          } else {
            const priceNum = edge.sqrtPriceX96 * edge.sqrtPriceX96;
            if (priceNum > 0n) {
              amountOut = (amountInAfterFee << 192n) / priceNum;
            }
          }
        }

        outputs.push(amountOut);
        currentAmount = amountOut > 0n ? amountOut : currentAmount;
      } catch {
        outputs.push(0n);
      }
    }

    return outputs;
  }
}