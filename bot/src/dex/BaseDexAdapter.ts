/**
 * @file BaseDexAdapter.ts
 * @description Abstract base class implementing shared adapter logic: provider reference,
 *              address registry access, standard error wrapping, retry-wrapped RPC calls.
 */

import { ethers } from 'ethers';
import { DexId, ProtocolVersion } from '../config/constants';
import type { IDexAdapter, SwapParams, SwapCalldata, PoolState } from './types';
import { withRetry } from '../utils/retry';
import { createModuleLogger } from '../utils/logger';

export abstract class BaseDexAdapter implements IDexAdapter {
  abstract readonly dexId: DexId;
  abstract readonly name: string;
  abstract readonly version: ProtocolVersion;

  protected provider: ethers.Provider;
  protected factoryAddress: string;
  protected routerAddress: string;
  protected logger: ReturnType<typeof createModuleLogger>;

  constructor(
    provider: ethers.Provider,
    factoryAddress: string,
    routerAddress: string,
    loggerName: string
  ) {
    this.provider = provider;
    this.factoryAddress = factoryAddress;
    this.routerAddress = routerAddress;
    this.logger = createModuleLogger(loggerName);
  }

  abstract getAmountOut(params: SwapParams): Promise<bigint>;
  abstract buildSwapCalldata(params: SwapParams, recipient: string, deadline: number): Promise<SwapCalldata>;
  abstract getPoolState(poolAddress: string): Promise<PoolState>;

  getFactoryAddress(): string {
    return this.factoryAddress;
  }

  getRouterAddress(): string {
    return this.routerAddress;
  }

  /**
   * Wraps an RPC call with retry logic.
   */
  protected async retryCall<T>(fn: () => Promise<T>, context: string = ''): Promise<T> {
    return withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 500,
      retryableErrors: ['TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR', 'CALL_EXCEPTION'],
      onRetry: (error, attempt) => {
        this.logger.warn(`Retry ${context}`, {
          attempt,
          dex: this.name,
          error: error.message,
        });
      },
    });
  }

  /**
   * Creates a contract instance with the provider.
   */
  protected getContract(address: string, abi: readonly string[]): ethers.Contract {
    return new ethers.Contract(address, abi, this.provider);
  }

  /**
   * Updates the provider reference.
   */
  updateProvider(provider: ethers.Provider): void {
    this.provider = provider;
  }
}