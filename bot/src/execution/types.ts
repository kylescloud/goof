/**
 * @file execution/types.ts
 * @description Type definitions for the execution module.
 */

import type { SimulationResult } from '../simulation/types';

export interface ExecutionResult {
  success: boolean;
  txHash: string;
  blockNumber: number;
  gasUsed: bigint;
  gasCostUsd: number;
  profit: bigint;
  profitUsd: number;
  executionTimeMs: number;
  simulationResult: SimulationResult;
  error?: string;
  failureReason?: string;
}

export interface TransactionRequest {
  to: string;
  data: string;
  value: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce: number;
  chainId: number;
  type: 2;
}

export enum FailureCategory {
  REVERT = 'REVERT',
  OUT_OF_GAS = 'OUT_OF_GAS',
  NONCE_TOO_LOW = 'NONCE_TOO_LOW',
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  TIMEOUT = 'TIMEOUT',
  NETWORK_ERROR = 'NETWORK_ERROR',
  SLIPPAGE = 'SLIPPAGE',
  FRONTRUN = 'FRONTRUN',
  UNKNOWN = 'UNKNOWN',
}

export interface CircuitBreakerState {
  isOpen: boolean;
  consecutiveFailures: number;
  lastFailureTime: number;
  cooldownUntil: number;
  totalFailures: number;
  totalSuccesses: number;
}