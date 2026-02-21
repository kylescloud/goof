/**
 * @file GasEstimator.ts
 * @description Estimates gas costs for arbitrage transactions. Reads current base fee from the
 *              latest block. Applies priority fee. Converts gas cost to USD using ETH oracle price.
 */

import { ethers } from 'ethers';
import { GAS_FLASH_LOAN_OVERHEAD, GAS_PER_V2_SWAP, GAS_PER_V3_SWAP, GAS_PER_AERODROME_SWAP, GAS_PER_AERODROME_CL_SWAP, DEX_PROTOCOL_VERSION, ProtocolVersion, DexId } from '../config/constants';
import { TOKENS } from '../config/addresses';
import { OracleRegistry } from '../oracle/OracleRegistry';
import { fromBigInt } from '../utils/bigIntMath';
import { createModuleLogger } from '../utils/logger';
import type { GraphEdge } from '../graph/types';
import type { GasEstimate } from './types';

const logger = createModuleLogger('GasEstimator');

export class GasEstimator {
  private provider: ethers.Provider;
  private oracleRegistry: OracleRegistry;
  private priorityFeeGwei: number;
  private cachedBaseFee: bigint;
  private lastBaseFeeBlock: number;

  constructor(provider: ethers.Provider, oracleRegistry: OracleRegistry, priorityFeeGwei: number = 0.1) {
    this.provider = provider;
    this.oracleRegistry = oracleRegistry;
    this.priorityFeeGwei = priorityFeeGwei;
    this.cachedBaseFee = 0n;
    this.lastBaseFeeBlock = 0;
  }

  /**
   * Estimates the gas cost for an arbitrage path.
   * @param edges The swap edges in the path.
   * @param blockNumber Optional block number to use for base fee.
   * @returns The gas estimate with USD cost.
   */
  async estimateGasCost(edges: GraphEdge[], blockNumber?: number): Promise<GasEstimate> {
    const totalGas = this._estimateTotalGas(edges);
    const baseFeeGwei = await this._getBaseFeeGwei(blockNumber);
    const effectiveGasPriceGwei = baseFeeGwei + this.priorityFeeGwei;

    // Gas cost in wei
    const gasCostWei = totalGas * BigInt(Math.floor(effectiveGasPriceGwei * 1e9));

    // Get ETH price in USD
    const ethPriceUsd = await this._getEthPriceUsd();
    const gasCostEth = fromBigInt(gasCostWei, 18);
    const gasCostUsd = gasCostEth * ethPriceUsd;

    return {
      totalGas,
      gasPriceGwei: effectiveGasPriceGwei,
      gasCostWei,
      gasCostUsd,
    };
  }

  /**
   * Gets the current base fee in gwei.
   */
  async getBaseFeeGwei(blockNumber?: number): Promise<number> {
    return this._getBaseFeeGwei(blockNumber);
  }

  /**
   * Gets the current ETH price in USD.
   */
  async getEthPriceUsd(): Promise<number> {
    return this._getEthPriceUsd();
  }

  /**
   * Estimates total gas for a set of swap edges.
   */
  private _estimateTotalGas(edges: GraphEdge[]): bigint {
    let totalGas = GAS_FLASH_LOAN_OVERHEAD;

    for (const edge of edges) {
      if (edge.dexId === DexId.AERODROME) {
        totalGas += GAS_PER_AERODROME_SWAP;
      } else if (edge.dexId === DexId.AERODROME_SLIPSTREAM) {
        totalGas += GAS_PER_AERODROME_CL_SWAP;
      } else {
        const version = DEX_PROTOCOL_VERSION[edge.dexId];
        totalGas += version === ProtocolVersion.V3 ? GAS_PER_V3_SWAP : GAS_PER_V2_SWAP;
      }
    }

    return totalGas;
  }

  /**
   * Gets the base fee from the latest block.
   */
  private async _getBaseFeeGwei(blockNumber?: number): Promise<number> {
    try {
      const block = await this.provider.getBlock(blockNumber ?? 'latest');
      if (block?.baseFeePerGas) {
        this.cachedBaseFee = block.baseFeePerGas;
        this.lastBaseFeeBlock = block.number;
        return Number(block.baseFeePerGas) / 1e9;
      }
    } catch (error) {
      logger.warn('Failed to get base fee', { error: (error as Error).message });
    }

    // Fallback to cached or default
    if (this.cachedBaseFee > 0n) {
      return Number(this.cachedBaseFee) / 1e9;
    }
    return 0.1; // Default 0.1 gwei for Base
  }

  /**
   * Gets the ETH price in USD from the oracle.
   */
  private async _getEthPriceUsd(): Promise<number> {
    try {
      const price = await this.oracleRegistry.getTokenPriceUSD(TOKENS.WETH.address);
      return price.priceUsd;
    } catch {
      return 3000; // Fallback ETH price
    }
  }

  /**
   * Updates the provider reference.
   */
  updateProvider(provider: ethers.Provider): void {
    this.provider = provider;
  }
}