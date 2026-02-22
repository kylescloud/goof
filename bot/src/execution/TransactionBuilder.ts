/**
 * @file TransactionBuilder.ts
 * @description Encodes the FlashLoanParams struct into calldata for the ArbitrageExecutor contract.
 *              Builds the complete EIP-1559 transaction object ready for signing and submission.
 */

import { ethers } from 'ethers';
import { ARBITRAGE_EXECUTOR_ABI, DexId } from '../config/constants';
import { CHAIN_ID, DEX_ADDRESSES } from '../config/addresses';
import { createModuleLogger } from '../utils/logger';
import type { SimulationResult } from '../simulation/types';
import type { GraphEdge } from '../graph/types';
import type { TransactionRequest } from './types';

const logger = createModuleLogger('TransactionBuilder');

export class TransactionBuilder {
  private executorAddress: string;
  private contractInterface: ethers.Interface;

  constructor(executorAddress: string) {
    this.executorAddress = executorAddress;
    this.contractInterface = new ethers.Interface(ARBITRAGE_EXECUTOR_ABI);
  }

  /**
   * Builds a complete transaction request from a simulation result.
   * @param simulation The simulation result.
   * @param nonce The transaction nonce.
   * @param maxFeePerGas The max fee per gas (EIP-1559).
   * @param maxPriorityFeePerGas The max priority fee per gas.
   * @param gasLimit The gas limit.
   * @param deadline The deadline timestamp.
   * @returns The transaction request ready for signing.
   */
  buildTransaction(
    simulation: SimulationResult,
    nonce: number,
    maxFeePerGas: bigint,
    maxPriorityFeePerGas: bigint,
    gasLimit: bigint,
    deadline: number
  ): TransactionRequest {
    const path = simulation.path;

    // Encode swap steps
    const steps = path.edges.map((edge, idx) => ({
      dexId: edge.dexId,
      tokenIn: edge.from,
      tokenOut: edge.to,
      pool: edge.poolAddress,
      fee: edge.fee,
      minAmountOut: this._calcMinAmountOut(simulation, idx),
      extraData: this._encodeExtraData(edge),
    }));

    // Calculate minimum return with slippage buffer
    const minReturn = simulation.totalRepayment;

    const params = {
      flashAsset: path.flashAsset,
      flashAmount: path.flashAmount,
      steps,
      minReturnAmount: minReturn,
      deadline,
    };

    const data = this.contractInterface.encodeFunctionData('executeArbitrage', [params]);

    const tx: TransactionRequest = {
      to: this.executorAddress,
      data,
      value: 0n,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      nonce,
      chainId: CHAIN_ID,
      type: 2,
    };

    logger.debug('Transaction built', {
      flashAsset: path.flashAsset,
      flashAmount: path.flashAmount.toString(),
      steps: steps.length,
      gasLimit: gasLimit.toString(),
      nonce,
    });

    return tx;
  }

  /**
   * Encodes just the calldata for a flash loan execution.
   */
  encodeCalldata(
    flashAsset: string,
    flashAmount: bigint,
    steps: Array<{
      dexId: number;
      tokenIn: string;
      tokenOut: string;
      pool: string;
      fee: number;
      minAmountOut: bigint;
      extraData: string;
    }>,
    minReturnAmount: bigint,
    deadline: number
  ): string {
    return this.contractInterface.encodeFunctionData('executeArbitrage', [{
      flashAsset,
      flashAmount,
      steps,
      minReturnAmount,
      deadline,
    }]);
  }

  /**
   * Decodes a transaction's calldata back into FlashLoanParams.
   */
  decodeCalldata(data: string): {
    flashAsset: string;
    flashAmount: bigint;
    steps: Array<{
      dexId: number;
      tokenIn: string;
      tokenOut: string;
      pool: string;
      fee: number;
      minAmountOut: bigint;
      extraData: string;
    }>;
    minReturnAmount: bigint;
    deadline: bigint;
  } {
    const decoded = this.contractInterface.decodeFunctionData('executeArbitrage', data);
    const params = decoded[0];

    return {
      flashAsset: params.flashAsset,
      flashAmount: BigInt(params.flashAmount),
      steps: params.steps.map((s: {
        dexId: bigint | number;
        tokenIn: string;
        tokenOut: string;
        pool: string;
        fee: bigint | number;
        minAmountOut: bigint;
        extraData: string;
      }) => ({
        dexId: Number(s.dexId),
        tokenIn: s.tokenIn,
        tokenOut: s.tokenOut,
        pool: s.pool,
        fee: Number(s.fee),
        minAmountOut: BigInt(s.minAmountOut),
        extraData: s.extraData,
      })),
      minReturnAmount: BigInt(params.minReturnAmount),
      deadline: BigInt(params.deadline),
    };
  }

  /**
   * Encodes the extraData field for a swap step.
   * - Aerodrome Classic (dexId=4): abi.encode(router, stable, factory)
   * - Aerodrome Slipstream (dexId=5): abi.encode(router, tickSpacing)
   * - All other DEXes: '0x' (empty)
   */
  private _encodeExtraData(edge: GraphEdge): string {
    if (edge.dexId === DexId.AERODROME) {
      const router  = DEX_ADDRESSES.aerodrome.router;
      const factory = DEX_ADDRESSES.aerodrome.factory;
      // stable flag: default to false (volatile) if not set
      const stable  = edge.stable === true;
      return ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'bool', 'address'],
        [router, stable, factory]
      );
    }
    if (edge.dexId === DexId.AERODROME_SLIPSTREAM) {
      const router      = DEX_ADDRESSES.aerodromeSlipstream.router;
      // tickSpacing: use stored value, fall back to 100 (most common)
      const tickSpacing = edge.tickSpacing ?? 100;
      return ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'int24'],
        [router, tickSpacing]
      );
    }
    return '0x';
  }

  /**
   * Calculates per-step minAmountOut as 99% of the simulated output (1% slippage buffer).
   * Falls back to 0 if simulation data is unavailable for this step.
   */
  private _calcMinAmountOut(simulation: SimulationResult, stepIdx: number): bigint {
    try {
      // stepOutputs is an optional array on SimulationResult tracking per-step amounts
      const outputs = simulation.stepOutputs;
      if (outputs && outputs[stepIdx] !== undefined && outputs[stepIdx] > 0n) {
        // 99% of simulated output = 1% slippage tolerance
        return (outputs[stepIdx] * 99n) / 100n;
      }
    } catch { /* ignore */ }
    return 0n;
  }
}