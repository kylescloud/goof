/**
 * @file MulticallBatcher.ts
 * @description Batches multiple eth_call requests into a single Multicall3 aggregate call.
 *              Accepts an array of {target, callData} objects. Encodes the Multicall3 aggregate call.
 *              Submits as a single eth_call. Decodes and returns the results array.
 */

import { ethers } from 'ethers';
import { MULTICALL3 } from '../config/addresses';
import { MULTICALL3_ABI, MULTICALL_BATCH_SIZE } from '../config/constants';
import type { MulticallRequest, MulticallResult } from './types';
import { withRetry } from '../utils/retry';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('MulticallBatcher');

export class MulticallBatcher {
  private provider: ethers.Provider;
  private multicallAddress: string;
  private multicallContract: ethers.Contract;
  private batchSize: number;

  constructor(provider: ethers.Provider, batchSize: number = MULTICALL_BATCH_SIZE) {
    this.provider = provider;
    this.multicallAddress = MULTICALL3;
    this.multicallContract = new ethers.Contract(this.multicallAddress, MULTICALL3_ABI, provider);
    this.batchSize = batchSize;
  }

  /**
   * Executes a batch of calls via Multicall3 aggregate3.
   * @param requests Array of multicall requests.
   * @returns Array of multicall results in the same order as requests.
   */
  async call(requests: MulticallRequest[]): Promise<MulticallResult[]> {
    if (requests.length === 0) return [];

    // Split into batches if necessary
    if (requests.length > this.batchSize) {
      return this._callBatched(requests);
    }

    return this._executeBatch(requests);
  }

  /**
   * Executes a single batch of multicall requests.
   */
  private async _executeBatch(requests: MulticallRequest[]): Promise<MulticallResult[]> {
    const calls = requests.map((req) => ({
      target: req.target,
      allowFailure: req.allowFailure !== false, // Default to true
      callData: req.callData,
    }));

    try {
      const results = await withRetry(
        async () => {
          return await this.multicallContract.aggregate3.staticCall(calls);
        },
        {
          maxAttempts: 3,
          baseDelayMs: 500,
          retryableErrors: ['TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR', 'CALL_EXCEPTION'],
        }
      );

      return results.map((result: { success: boolean; returnData: string }) => ({
        success: result.success,
        returnData: result.returnData,
      }));
    } catch (error) {
      logger.error('Multicall batch failed', {
        batchSize: requests.length,
        error: (error as Error).message,
      });

      // Return all failures
      return requests.map(() => ({
        success: false,
        returnData: '0x',
      }));
    }
  }

  /**
   * Splits large request arrays into batches and executes them sequentially.
   */
  private async _callBatched(requests: MulticallRequest[]): Promise<MulticallResult[]> {
    const results: MulticallResult[] = [];
    const batches: MulticallRequest[][] = [];

    for (let i = 0; i < requests.length; i += this.batchSize) {
      batches.push(requests.slice(i, i + this.batchSize));
    }

    logger.debug('Executing multicall in batches', {
      totalRequests: requests.length,
      batchCount: batches.length,
      batchSize: this.batchSize,
    });

    for (const batch of batches) {
      const batchResults = await this._executeBatch(batch);
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Executes multiple batches concurrently with a concurrency limit.
   * @param requests Array of multicall requests.
   * @param concurrency Maximum number of concurrent batches.
   * @returns Array of multicall results.
   */
  async callConcurrent(requests: MulticallRequest[], concurrency: number = 5): Promise<MulticallResult[]> {
    if (requests.length === 0) return [];
    if (requests.length <= this.batchSize) return this._executeBatch(requests);

    const batches: MulticallRequest[][] = [];
    for (let i = 0; i < requests.length; i += this.batchSize) {
      batches.push(requests.slice(i, i + this.batchSize));
    }

    const results: MulticallResult[][] = new Array(batches.length);
    let batchIndex = 0;

    const executeBatchAtIndex = async (): Promise<void> => {
      while (batchIndex < batches.length) {
        const currentIndex = batchIndex++;
        if (currentIndex >= batches.length) break;
        results[currentIndex] = await this._executeBatch(batches[currentIndex]);
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, batches.length) }, () =>
      executeBatchAtIndex()
    );

    await Promise.all(workers);

    return results.flat();
  }

  /**
   * Helper to encode a function call for use in multicall.
   * @param abi The ABI fragment array.
   * @param functionName The function name to encode.
   * @param args The function arguments.
   * @returns The encoded calldata.
   */
  static encodeCall(abi: readonly string[], functionName: string, args: unknown[] = []): string {
    const iface = new ethers.Interface(abi);
    return iface.encodeFunctionData(functionName, args);
  }

  /**
   * Updates the provider reference.
   */
  updateProvider(provider: ethers.Provider): void {
    this.provider = provider;
    this.multicallContract = new ethers.Contract(this.multicallAddress, MULTICALL3_ABI, provider);
  }
}