/**
 * @file strategies/types.ts
 * @description Type definitions for the strategy module.
 */

import type { ArbitragePath, GraphEdge } from '../graph/types';

export interface IStrategy {
  readonly name: string;
  readonly id: string;

  /**
   * Finds arbitrage opportunities for the current market state.
   * @returns Array of arbitrage paths found by this strategy.
   */
  findOpportunities(): Promise<ArbitragePath[]>;

  /**
   * Returns whether this strategy is enabled.
   */
  isEnabled(): boolean;
}

export interface StrategyResult {
  strategyName: string;
  opportunities: ArbitragePath[];
  duration: number;
  error?: string;
}

export interface SwapStepParams {
  dexId: number;
  tokenIn: string;
  tokenOut: string;
  pool: string;
  fee: number;
  minAmountOut: bigint;
  extraData: string;
}

export interface FlashLoanRequest {
  flashAsset: string;
  flashAmount: bigint;
  steps: SwapStepParams[];
  minReturnAmount: bigint;
  deadline: number;
}