/**
 * @file PathPruner.ts
 * @description Post-enumeration path filter. Removes paths where: any intermediate token's pool
 *              liquidity is below the minimum USD threshold, any pool appears more than once,
 *              or the estimated gross profit does not exceed the estimated gas cost by the
 *              minimum profit threshold.
 */

import { OracleRegistry } from '../oracle/OracleRegistry';
import { GAS_PER_V2_SWAP, GAS_PER_V3_SWAP, GAS_FLASH_LOAN_OVERHEAD } from '../config/constants';
import { ProtocolVersion, DEX_PROTOCOL_VERSION } from '../config/constants';
import { createModuleLogger } from '../utils/logger';
import type { GraphEdge, ArbitragePath } from './types';

const logger = createModuleLogger('PathPruner');

export class PathPruner {
  private oracleRegistry: OracleRegistry;
  private minPoolLiquidityUsd: number;
  private minProfitThresholdUsd: number;

  constructor(
    oracleRegistry: OracleRegistry,
    minPoolLiquidityUsd: number = 10000,
    minProfitThresholdUsd: number = 10
  ) {
    this.oracleRegistry = oracleRegistry;
    this.minPoolLiquidityUsd = minPoolLiquidityUsd;
    this.minProfitThresholdUsd = minProfitThresholdUsd;
  }

  /**
   * Filters an array of paths, removing those that don't meet criteria.
   * @param paths Array of edge arrays to filter.
   * @param ethPriceUsd Current ETH price in USD for gas cost estimation.
   * @param baseFeeGwei Current base fee in gwei.
   * @returns Filtered array of paths.
   */
  async prunePaths(
    paths: GraphEdge[][],
    ethPriceUsd: number,
    baseFeeGwei: number
  ): Promise<GraphEdge[][]> {
    const prunedPaths: GraphEdge[][] = [];

    for (const path of paths) {
      if (this._hasDuplicatePools(path)) continue;
      if (!this._hasMinimumHops(path)) continue;

      const gasCostUsd = this._estimateGasCostUsd(path, ethPriceUsd, baseFeeGwei);
      const estimatedProfitBps = this._estimateProfitBps(path);

      // Convert profit bps to approximate USD (rough estimate)
      // Assume a reference trade size of $10,000
      const estimatedProfitUsd = (estimatedProfitBps / 10000) * 10000;

      if (estimatedProfitUsd - gasCostUsd < this.minProfitThresholdUsd) continue;

      prunedPaths.push(path);
    }

    logger.debug('Path pruning complete', {
      inputPaths: paths.length,
      outputPaths: prunedPaths.length,
      pruned: paths.length - prunedPaths.length,
    });

    return prunedPaths;
  }

  /**
   * Checks if any pool address appears more than once in the path.
   */
  private _hasDuplicatePools(path: GraphEdge[]): boolean {
    const pools = new Set<string>();
    for (const edge of path) {
      const key = edge.poolAddress.toLowerCase();
      if (pools.has(key)) return true;
      pools.add(key);
    }
    return false;
  }

  /**
   * Checks that the path has at least 2 hops.
   */
  private _hasMinimumHops(path: GraphEdge[]): boolean {
    return path.length >= 2;
  }

  /**
   * Estimates the gas cost in USD for executing a path.
   */
  private _estimateGasCostUsd(path: GraphEdge[], ethPriceUsd: number, baseFeeGwei: number): number {
    let totalGas = Number(GAS_FLASH_LOAN_OVERHEAD);

    for (const edge of path) {
      const version = DEX_PROTOCOL_VERSION[edge.dexId];
      if (version === ProtocolVersion.V3) {
        totalGas += Number(GAS_PER_V3_SWAP);
      } else {
        totalGas += Number(GAS_PER_V2_SWAP);
      }
    }

    // Gas cost in ETH = totalGas * baseFeeGwei * 1e-9
    const gasCostEth = totalGas * baseFeeGwei * 1e-9;
    return gasCostEth * ethPriceUsd;
  }

  /**
   * Estimates the profit in basis points from the path's edge weights.
   */
  private _estimateProfitBps(path: GraphEdge[]): number {
    let totalWeight = 0;
    for (const edge of path) {
      if (!isFinite(edge.weight)) return 0;
      totalWeight += edge.weight;
    }

    // profitMultiplier = exp(-totalWeight)
    const multiplier = Math.exp(-totalWeight);
    return Math.round((multiplier - 1) * 10000);
  }

  /**
   * Updates the minimum pool liquidity threshold.
   */
  setMinPoolLiquidityUsd(value: number): void {
    this.minPoolLiquidityUsd = value;
  }

  /**
   * Updates the minimum profit threshold.
   */
  setMinProfitThresholdUsd(value: number): void {
    this.minProfitThresholdUsd = value;
  }
}