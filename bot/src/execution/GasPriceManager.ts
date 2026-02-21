/**
 * @file GasPriceManager.ts
 * @description Manages EIP-1559 gas pricing. Reads base fee from latest block, applies
 *              configurable priority fee, enforces max gas price ceiling.
 */

import { ethers } from 'ethers';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('GasPriceManager');

export interface GasPriceData {
  baseFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasPriceGwei: number;
}

export class GasPriceManager {
  private provider: ethers.Provider;
  private maxGasPriceGwei: number;
  private priorityFeeGwei: number;
  private lastBaseFee: bigint;
  private lastUpdateBlock: number;

  constructor(provider: ethers.Provider, maxGasPriceGwei: number = 50, priorityFeeGwei: number = 0.1) {
    this.provider = provider;
    this.maxGasPriceGwei = maxGasPriceGwei;
    this.priorityFeeGwei = priorityFeeGwei;
    this.lastBaseFee = 0n;
    this.lastUpdateBlock = 0;
  }

  /**
   * Gets the current optimal gas price parameters for EIP-1559 transactions.
   * @returns Gas price data with base fee, priority fee, and max fee.
   */
  async getGasPrice(): Promise<GasPriceData> {
    const block = await this.provider.getBlock('latest');
    const baseFee = block?.baseFeePerGas ?? 100000000n; // Default 0.1 gwei

    this.lastBaseFee = baseFee;
    this.lastUpdateBlock = block?.number ?? 0;

    const priorityFee = BigInt(Math.floor(this.priorityFeeGwei * 1e9));
    const maxGasPrice = BigInt(Math.floor(this.maxGasPriceGwei * 1e9));

    // maxFeePerGas = 2 * baseFee + priorityFee (standard EIP-1559 formula)
    let maxFeePerGas = baseFee * 2n + priorityFee;

    // Cap at configured maximum
    if (maxFeePerGas > maxGasPrice) {
      maxFeePerGas = maxGasPrice;
    }

    const gasPriceGwei = Number(maxFeePerGas) / 1e9;

    return {
      baseFeePerGas: baseFee,
      maxPriorityFeePerGas: priorityFee,
      maxFeePerGas,
      gasPriceGwei,
    };
  }

  /**
   * Checks if the current gas price is within acceptable limits.
   * @returns True if gas price is acceptable.
   */
  async isGasPriceAcceptable(): Promise<boolean> {
    const gasData = await this.getGasPrice();
    return gasData.gasPriceGwei <= this.maxGasPriceGwei;
  }

  /**
   * Gets the last known base fee without making an RPC call.
   */
  getLastBaseFee(): bigint {
    return this.lastBaseFee;
  }

  /**
   * Updates the max gas price ceiling.
   */
  setMaxGasPrice(gwei: number): void {
    this.maxGasPriceGwei = gwei;
    logger.info('Max gas price updated', { maxGasPriceGwei: gwei });
  }

  /**
   * Updates the priority fee.
   */
  setPriorityFee(gwei: number): void {
    this.priorityFeeGwei = gwei;
  }

  updateProvider(provider: ethers.Provider): void {
    this.provider = provider;
  }
}