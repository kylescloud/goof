/**
 * @file BaseStrategy.ts
 * @description Abstract base class for all strategy modules. Provides reference to pool registry,
 *              token graph, DEX adapter registry, oracle registry, and config. Defines the abstract
 *              findOpportunities() method. Provides shared helper methods.
 *
 *              VERBOSE MODE: When LOG_OPPORTUNITIES=true (default), logs EVERY candidate path
 *              scanned — profitable or not — with full details: amounts, gross profit, gas cost,
 *              net profit, and verdict.
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
import { safeFlashAmountFromV2Edge, safeFlashAmountFromV3Edge } from './flashAmountUtils';
import { createModuleLogger } from '../utils/logger';

// ─── Verbose opportunity logging ─────────────────────────────────────────────
// Set LOG_OPPORTUNITIES=false in .env to suppress per-candidate logs
const LOG_OPPORTUNITIES = process.env.LOG_OPPORTUNITIES !== 'false';
const LOG_UNPROFITABLE  = process.env.LOG_UNPROFITABLE  !== 'false'; // log even unprofitable

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
   * Uses hard per-token caps to prevent absurd amounts from low-liquidity pools.
   */
  protected estimateFlashLoanAmount(edges: GraphEdge[], flashAssetDecimals: number): bigint {
    if (edges.length === 0) return 0n;
    const flashAsset = edges[0].from;

    // Use the first edge to determine flash amount
    const firstEdge = edges[0];
    if (firstEdge.reserve0 && firstEdge.reserve1) {
      return safeFlashAmountFromV2Edge(firstEdge, flashAsset, flashAssetDecimals);
    }
    return safeFlashAmountFromV3Edge(flashAsset, flashAssetDecimals);
  }

  /**
   * Estimates the net profit in USD for a path.
   * Also logs the full opportunity details (profitable or not) when verbose mode is on.
   */
  protected async estimateNetProfitUsd(
    flashAsset: string,
    flashAmount: bigint,
    expectedReturn: bigint,
    flashAssetDecimals: number,
    edges: GraphEdge[],
    candidateLabel?: string
  ): Promise<{ grossProfitUsd: number; gasCostUsd: number; netProfitUsd: number }> {
    // Calculate flash loan premium (0.05% = 5 bps)
    const premium = (flashAmount * FLASH_LOAN_PREMIUM_BPS) / FLASH_LOAN_PREMIUM_DIVISOR;
    const totalRepayment = flashAmount + premium;

    // Get asset price for USD conversion
    // OracleRegistry always returns a value (stablecoin fallback = $1.00, ETH fallback = $2000)
    let assetPrice = 1.0;
    try {
      const priceResult = await this.oracleRegistry.getTokenPriceUSD(flashAsset);
      // Only use oracle price if it's non-zero and reasonable
      if (priceResult.priceUsd > 0 && priceResult.priceUsd < 1_000_000) {
        assetPrice = priceResult.priceUsd;
      }
    } catch {
      // fallback: use 1.0 for stablecoins (safe default)
    }

    const flashAmountHuman = fromBigInt(flashAmount, flashAssetDecimals);
    const returnHuman      = fromBigInt(expectedReturn, flashAssetDecimals);
    const repayHuman       = fromBigInt(totalRepayment, flashAssetDecimals);

    if (expectedReturn <= totalRepayment) {
      const deficit = fromBigInt(totalRepayment - expectedReturn, flashAssetDecimals);
      const deficitUsd = deficit * assetPrice;

      if (LOG_OPPORTUNITIES && LOG_UNPROFITABLE) {
        this._logCandidate({
          label: candidateLabel,
          edges,
          flashAsset,
          flashAmountHuman,
          returnHuman,
          repayHuman,
          grossProfitUsd: 0,
          gasCostUsd: 0,
          netProfitUsd: -(deficitUsd),
          verdict: `UNPROFITABLE (deficit: $${deficitUsd.toFixed(4)})`,
        });
      }
      return { grossProfitUsd: 0, gasCostUsd: 0, netProfitUsd: -(deficitUsd) };
    }

    const grossProfit    = expectedReturn - totalRepayment;
    const grossProfitUsd = fromBigInt(grossProfit, flashAssetDecimals) * assetPrice;

    // Estimate gas cost
    const gasCostUsd = await this._estimateGasCostUsd(edges);
    const netProfitUsd = grossProfitUsd - gasCostUsd;

    const verdict = netProfitUsd >= this.config.minProfitThresholdUsd
      ? `✅ PROFITABLE ($${netProfitUsd.toFixed(4)} net)`
      : `⚠️  BELOW THRESHOLD ($${netProfitUsd.toFixed(4)} < $${this.config.minProfitThresholdUsd} min)`;

    if (LOG_OPPORTUNITIES) {
      this._logCandidate({
        label: candidateLabel,
        edges,
        flashAsset,
        flashAmountHuman,
        returnHuman,
        repayHuman,
        grossProfitUsd,
        gasCostUsd,
        netProfitUsd,
        verdict,
      });
    }

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
   * Logs a full candidate opportunity with all details.
   */
  private _logCandidate(params: {
    label?: string;
    edges: GraphEdge[];
    flashAsset: string;
    flashAmountHuman: number;
    returnHuman: number;
    repayHuman: number;
    grossProfitUsd: number;
    gasCostUsd: number;
    netProfitUsd: number;
    verdict: string;
  }): void {
    const { label, edges, flashAsset, flashAmountHuman, returnHuman, repayHuman,
            grossProfitUsd, gasCostUsd, netProfitUsd, verdict } = params;

    // Build path string: TOKEN_A -[DEX fee%]-> TOKEN_B -[DEX fee%]-> TOKEN_C
    const pathStr = edges.map((e, i) => {
      // fee is in ppm (e.g. 3000 = 0.3%, 500 = 0.05%, 100 = 0.01%, 9 = 0.0009%)
      const feeStr = `${(e.fee / 10000).toFixed(4)}%`;
      const fromShort = e.from.slice(0, 6) + '…' + e.from.slice(-4);
      const toShort   = e.to.slice(0, 6)   + '…' + e.to.slice(-4);
      const poolShort = e.poolAddress.slice(0, 8) + '…';
      return i === 0
        ? `${fromShort} -[${e.dexName} ${feeStr} pool:${poolShort}]-> ${toShort}`
        : `-[${e.dexName} ${feeStr} pool:${poolShort}]-> ${toShort}`;
    }).join(' ');

    const flashShort = flashAsset.slice(0, 6) + '…' + flashAsset.slice(-4);

    this.logger.info(`CANDIDATE ${label ?? ''}`, {
      path: pathStr,
      flashAsset: flashShort,
      flashAmount: flashAmountHuman.toFixed(6),
      expectedReturn: returnHuman.toFixed(6),
      repayment: repayHuman.toFixed(6),
      grossProfitUsd: `$${grossProfitUsd.toFixed(4)}`,
      gasCostUsd: `$${gasCostUsd.toFixed(4)}`,
      netProfitUsd: `$${netProfitUsd.toFixed(4)}`,
      verdict,
    });
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

    // Get ETH price — OracleRegistry always returns a value (fallback = $2000)
    let ethPriceUsd = 2000; // conservative fallback
    try {
      const ethPrice = await this.oracleRegistry.getTokenPriceUSD(
        '0x4200000000000000000000000000000000000006' // WETH on Base
      );
      if (ethPrice.priceUsd > 100 && ethPrice.priceUsd < 100_000) {
        ethPriceUsd = ethPrice.priceUsd;
      }
    } catch {
      // use fallback
    }

    // Base L2 typically 0.001–0.01 gwei base fee
    const baseFeeGwei = 0.005;
    const gasCostEth = totalGas * baseFeeGwei * 1e-9;
    return gasCostEth * ethPriceUsd;
  }
}