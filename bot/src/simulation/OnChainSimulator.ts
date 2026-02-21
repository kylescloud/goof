/**
 * @file OnChainSimulator.ts
 * @description Calls the ArbitrageExecutor.simulateArbitrage() view function via eth_call.
 *              Encodes the FlashLoanParams struct, submits the call, and decodes the returned
 *              (expectedProfit, isProfitable) tuple.
 */

import { ethers } from 'ethers';
import { ARBITRAGE_EXECUTOR_ABI } from '../config/constants';
import { withRetry } from '../utils/retry';
import { createModuleLogger } from '../utils/logger';
import type { SwapStepParams } from '../strategies/types';

const logger = createModuleLogger('OnChainSimulator');

export class OnChainSimulator {
  private provider: ethers.Provider;
  private executorAddress: string;
  private contract: ethers.Contract;

  constructor(provider: ethers.Provider, executorAddress: string) {
    this.provider = provider;
    this.executorAddress = executorAddress;
    this.contract = new ethers.Contract(executorAddress, ARBITRAGE_EXECUTOR_ABI, provider);
  }

  /**
   * Simulates an arbitrage path using the on-chain simulateArbitrage() view function.
   * @param flashAsset The flash loan asset address.
   * @param flashAmount The flash loan amount.
   * @param steps The swap steps.
   * @param minReturnAmount The minimum return amount.
   * @param deadline The deadline timestamp.
   * @returns The simulation result (profit, isProfitable).
   */
  async simulate(
    flashAsset: string,
    flashAmount: bigint,
    steps: SwapStepParams[],
    minReturnAmount: bigint,
    deadline: number
  ): Promise<{ profit: bigint; isProfitable: boolean }> {
    const encodedSteps = steps.map((step) => ({
      dexId: step.dexId,
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      pool: step.pool,
      fee: step.fee,
      minAmountOut: step.minAmountOut,
      extraData: step.extraData,
    }));

    const params = {
      flashAsset,
      flashAmount,
      steps: encodedSteps,
      minReturnAmount,
      deadline,
    };

    return withRetry(
      async () => {
        try {
          const result = await this.contract.simulateArbitrage.staticCall(params);
          return {
            profit: BigInt(result[0]),
            isProfitable: result[1] as boolean,
          };
        } catch (error) {
          // If the simulation reverts, it means the path is not profitable
          logger.debug('On-chain simulation reverted', {
            flashAsset,
            flashAmount: flashAmount.toString(),
            error: (error as Error).message,
          });
          return { profit: 0n, isProfitable: false };
        }
      },
      {
        maxAttempts: 2,
        baseDelayMs: 500,
        retryableErrors: ['TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR'],
      }
    );
  }

  /**
   * Estimates gas for the executeArbitrage transaction.
   * @param flashAsset The flash loan asset address.
   * @param flashAmount The flash loan amount.
   * @param steps The swap steps.
   * @param minReturnAmount The minimum return amount.
   * @param deadline The deadline timestamp.
   * @param from The sender address.
   * @returns The estimated gas.
   */
  async estimateGas(
    flashAsset: string,
    flashAmount: bigint,
    steps: SwapStepParams[],
    minReturnAmount: bigint,
    deadline: number,
    from: string
  ): Promise<bigint> {
    const encodedSteps = steps.map((step) => ({
      dexId: step.dexId,
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      pool: step.pool,
      fee: step.fee,
      minAmountOut: step.minAmountOut,
      extraData: step.extraData,
    }));

    const params = {
      flashAsset,
      flashAmount,
      steps: encodedSteps,
      minReturnAmount,
      deadline,
    };

    try {
      const gasEstimate = await this.contract.executeArbitrage.estimateGas(params, { from });
      return gasEstimate;
    } catch (error) {
      logger.debug('Gas estimation failed, using fallback', { error: (error as Error).message });
      // Fallback: estimate based on number of steps
      const baseGas = 200000n;
      const perStepGas = 180000n;
      return baseGas + perStepGas * BigInt(steps.length);
    }
  }

  /**
   * Updates the provider reference.
   */
  updateProvider(provider: ethers.Provider): void {
    this.provider = provider;
    this.contract = new ethers.Contract(this.executorAddress, ARBITRAGE_EXECUTOR_ABI, provider);
  }
}