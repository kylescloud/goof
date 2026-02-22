/**
 * @file simulation/types.ts
 * @description Type definitions for the simulation module.
 */

import type { ArbitragePath } from '../graph/types';
import type { SwapStepParams } from '../strategies/types';

export interface SimulationResult {
  path: ArbitragePath;
  isProfitable: boolean;
  simulatedProfit: bigint;
  simulatedProfitUsd: number;
  gasEstimate: bigint;
  gasCostUsd: number;
  netProfitUsd: number;
  flashLoanPremium: bigint;
  totalRepayment: bigint;
  expectedReturn: bigint;
  simulationMethod: 'on-chain' | 'local' | 'off-chain-unverified';
  timestamp: number;
  blockNumber: number;
  stepOutputs?: bigint[];   // Per-step simulated output amounts (for per-step minAmountOut)
  error?: string;
}

export interface SimulationRequest {
  path: ArbitragePath;
  flashAsset: string;
  flashAmount: bigint;
  steps: SwapStepParams[];
  minReturnAmount: bigint;
  deadline: number;
}

export interface GasEstimate {
  totalGas: bigint;
  gasPriceGwei: number;
  gasCostWei: bigint;
  gasCostUsd: number;
}

export interface WorkerMessage {
  type: 'simulate' | 'result' | 'error' | 'ready';
  id: string;
  data?: SimulationRequest;
  result?: SimulationResult;
  error?: string;
}