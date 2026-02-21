/**
 * @file BaseStrategy.ts
 * @description Abstract base class for all strategy modules. Provides reference to pool registry,
 *              token graph, DEX adapter registry, oracle registry, and config. Defines the abstract
 *              findOpportunities() method. Provides shared helper methods.
 */

import { ethers } from 'ethers';
import { type Config } from '../config';
import { FLASH_LOAN_PREMIUM_BPS, FLASH_LOAN_PREMIUM_DIVISOR, GAS_FLASH_LOAN_OVERHEAD, GAS_PER_V2_SWAP, GAS_PER_V3_SWAP, DEX_PROTOCOL_VERSION, ProtocolVersion } from '../config/constants';
import type { PoolRegistry } from '../discovery/types';
import type { TokenGraph } from '../graph/TokenGraph';
import type { DexAdapterRegistry } from '../dex/DexAdapterRegistry';
import type { OracleRegistry } from '../oracle/OracleRegistry';
import type { ArbitragePath, GraphEdge } from '../graph/types';
import type { IStrategy, SwapStepParams } from './types';
import { fromBigInt } from '../utils/bigIntMath';
import { createModuleLogger } from '../utils/logger';

export abstract class BaseStrategy implements IStrategy {
  abstract readonly name: string;
  abstract readonly id: string;

  protected config: Config;
  protected registry: PoolRegistry;
  protected graph: TokenGraph;
  protected dexRegistry: DexAdapterRegistry;
  protected oracleRegistry: OracleRegistry;
  protected logger: ReturnType<typeof createModuleLogger>;
  protected enabled: boolean;

  constructor(
    config: Config,
    registry: PoolRegistry,
    graph: TokenGraph,
    dexRegistry: DexAdapterRegistry,
    oracleRegistry: OracleRegistry,
    loggerName: string
  ) {
    this.config = config;
    this.registry = registry;
    this.graph = graph;
    this.dexRegistry = dexRegistry;
    this.oracleRegistry = oracleRegistry;
    this.logger = createModuleLogger(loggerName);
    this.enabled = true;
  }

  abstract findOpportunities(): Promise<ArbitragePath[]>;

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Updates the pool registry reference (called on hot-reload).
   */
  updateRegistry(registry: PoolRegistry): void {
    this.registry = registry;
  }

  /**
   * Builds SwapStepParams from graph edges.
   */
  protected buildSwapSteps(edges: GraphEdge[]): SwapStepParams[] {
    return edges.map((edge) => ({
      dexId: edge.dexId,
      tokenIn: edge.from,
      tokenOut: edge.to,
      pool: edge.poolAddress,
      fee: edge.fee,
      minAmountOut: 0n,
      extraData: '0x',
    }));
  }

  /**
   * Estimates the flash loan amount based on pool liquidity.
   */
  protected estimateFlashLoanAmount(edges: GraphEdge[], flashAssetDecimals: number): bigint {
    // Use 1-5% of the smallest pool's liquidity as the flash loan amount
    let minLiquidity = BigInt(Number.MAX_SAFE_INTEGER);

    for (const edge of edges) {
      if (edge.reserve0 && edge.reserve1) {
        const relevantReserve = edge.from === edges[0].from ? edge.reserve0 : edge.reserve1;
        if (relevantReserve < minLiquidity) {
          minLiquidity = relevantReserve;
        }
      } else if (edge.liquidity) {
        if (edge.liquidity < minLiquidity) {
          minLiquidity = edge.liquidity;
        }
      }
    }

    // Use 2% of min liquidity, capped at reasonable amounts
    const flashAmount = minLiquidity / 50n;

    // Cap at $100k equivalent
    const maxAmount = 10n ** BigInt(flashAssetDecimals) * 100000n;
    return flashAmount < maxAmount ? flashAmount : maxAmount;
  }

  /**
   * Estimates the net profit in USD for a path.
   */
  protected async estimateNetProfitUsd(
    flashAsset: string,
    flashAmount: bigint,
    expectedReturn: bigint,
    flashAssetDecimals: number,
    edges: GraphEdge[]
  ): Promise<{ grossProfitUsd: number; gasCostUsd: number; netProfitUsd: number }> {
    // Calculate flash loan premium
    const premium = (flashAmount * FLASH_LOAN_PREMIUM_BPS) / FLASH_LOAN_PREMIUM_DIVISOR;
    const totalRepayment = flashAmount + premium;

    if (expectedReturn <= totalRepayment) {
      return { grossProfitUsd: 0, gasCostUsd: 0, netProfitUsd: 0 };
    }

    const grossProfit = expectedReturn - totalRepayment;

    // Convert to USD
    const assetPrice = await this.oracleRegistry.getTokenPriceUSD(flashAsset);
    const grossProfitUsd = fromBigInt(grossProfit, flashAssetDecimals) * assetPrice.priceUsd;

    // Estimate gas cost
    const gasCostUsd = await this._estimateGasCostUsd(edges);

    const netProfitUsd = grossProfitUsd - gasCostUsd;

    return { grossProfitUsd, gasCostUsd, netProfitUsd };
  }

  /**
   * Creates an ArbitragePath object from components.
   */
  protected createArbitragePath(
    edges: GraphEdge[],
    flashAsset: string,
    flashAmount: bigint,
    expectedOutput: bigint,
    grossProfitUsd: number,
    gasCostUsd: number,
    netProfitUsd: number,
    strategy: string
  ): ArbitragePath {
    const id = `${strategy}-${edges.map((e) => e.poolAddress.slice(0, 8)).join('-')}-${Date.now()}`;

    return {
      id,
      edges,
      flashAsset,
      flashAmount,
      expectedInputAmount: flashAmount,
      expectedOutputAmount: expectedOutput,
      expectedGrossProfitUsd: grossProfitUsd,
      estimatedGasCostUsd: gasCostUsd,
      estimatedNetProfitUsd: netProfitUsd,
      hops: edges.length,
      strategy,
      timestamp: Date.now(),
    };
  }

  /**
   * Estimates gas cost in USD for a set of edges.
   */
  private async _estimateGasCostUsd(edges: GraphEdge[]): Promise<number> {
    let totalGas = Number(GAS_FLASH_LOAN_OVERHEAD);

    for (const edge of edges) {
      const version = DEX_PROTOCOL_VERSION[edge.dexId];
      totalGas += version === ProtocolVersion.V3 ? Number(GAS_PER_V3_SWAP) : Number(GAS_PER_V2_SWAP);
    }

    // Get ETH price
    const ethPrice = await this.oracleRegistry.getTokenPriceUSD(
      '0x4200000000000000000000000000000000000006' // WETH on Base
    );

    // Assume 0.1 gwei base fee on Base (typically very low)
    const baseFeeGwei = 0.1;
    const gasCostEth = totalGas * baseFeeGwei * 1e-9;
    return gasCostEth * ethPrice.priceUsd;
  }
}