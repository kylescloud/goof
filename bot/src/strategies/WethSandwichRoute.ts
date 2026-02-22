/**
 * @file WethSandwichRoute.ts
 * @description Strategy 7: WETH Sandwich Route. Constructs multi-hop paths that use WETH as an
 *              intermediate token. Flash borrows a non-WETH Aave asset, swaps to WETH on one DEX,
 *              then swaps WETH back to the flash asset on another DEX, profiting from price
 *              differences in the WETH intermediate legs.
 *
 *              FIXES:
 *              - Uses safeFlashAmountFromV2Edge / safeFlashAmountFromV3Edge with hard caps
 *              - Validates minimum pool liquidity before scanning
 *              - Correct V3 price math using sqrtPriceX96
 *              - Skips pools with zero/invalid reserves
 */

import { BaseStrategy } from './BaseStrategy';
import { TOKENS, TOKEN_BY_ADDRESS } from '../config/addresses';
import { getAmountOut as v2GetAmountOut } from '../dex/math/V2Math';
import {
  safeFlashAmountFromV2Edge,
  safeFlashAmountFromV3Edge,
  hasMinimumV2Liquidity,
  hasValidV3Price,
} from './flashAmountUtils';
import type { ArbitragePath, GraphEdge } from '../graph/types';

export class WethSandwichRoute extends BaseStrategy {
  readonly name = 'WETH Sandwich Route';
  readonly id = 'weth-sandwich';

  async findOpportunities(): Promise<ArbitragePath[]> {
    const opportunities: ArbitragePath[] = [];
    const wethAddress = TOKENS.WETH.address.toLowerCase();
    const aaveAssets  = this.registry.meta.aaveAssets;

    this.logger.info(`Scanning ${aaveAssets.length} Aave assets for WETH sandwich routes`);

    let candidateCount = 0;

    for (const flashAsset of aaveAssets) {
      const flashLower = flashAsset.toLowerCase();
      if (flashLower === wethAddress) continue;

      const flashInfo = TOKEN_BY_ADDRESS[flashLower];
      if (!flashInfo) continue;

      const leg1Edges = this.graph.getEdgesBetween(flashLower, wethAddress);
      const leg2Edges = this.graph.getEdgesBetween(wethAddress, flashLower);

      if (leg1Edges.length === 0 || leg2Edges.length === 0) continue;

      // Try all combinations of leg1 and leg2 pools
      for (const buyEdge of leg1Edges) {
        // Skip pools with invalid state
        if (!this._isEdgeValid(buyEdge, flashInfo.decimals)) continue;

        for (const sellEdge of leg2Edges) {
          if (buyEdge.poolAddress === sellEdge.poolAddress) continue;
          if (!this._isEdgeValid(sellEdge, 18)) continue; // WETH is 18 decimals

          candidateCount++;
          const label = `#${candidateCount} [${flashInfo.symbol}→WETH→${flashInfo.symbol}] ${buyEdge.dexName}→${sellEdge.dexName}`;
          const result = await this._evaluateSandwich(flashAsset, flashInfo.decimals, buyEdge, sellEdge, label);
          if (result) opportunities.push(result);
        }
      }

      // Also try 3-hop: flashAsset -> tokenX -> WETH -> flashAsset
      const flashNeighbors = this.graph.getNeighbors(flashLower);
      for (const midToken of flashNeighbors) {
        if (midToken === wethAddress || midToken === flashLower) continue;

        const leg1 = this.graph.getEdgesBetween(flashLower, midToken);
        const leg2 = this.graph.getEdgesBetween(midToken, wethAddress);
        const leg3 = this.graph.getEdgesBetween(wethAddress, flashLower);

        if (leg1.length === 0 || leg2.length === 0 || leg3.length === 0) continue;

        const bestLeg1 = this._pickBestEdge(leg1);
        const bestLeg2 = this._pickBestEdge(leg2);
        const bestLeg3 = this._pickBestEdge(leg3);

        if (!bestLeg1 || !bestLeg2 || !bestLeg3) continue;
        if (!this._isEdgeValid(bestLeg1, flashInfo.decimals)) continue;

        const pools = new Set([bestLeg1.poolAddress, bestLeg2.poolAddress, bestLeg3.poolAddress]);
        if (pools.size < 3) continue;

        const midInfo = TOKEN_BY_ADDRESS[midToken] ?? { symbol: midToken.slice(0, 8) };
        candidateCount++;
        const label3 = `#${candidateCount} [${flashInfo.symbol}→${midInfo.symbol}→WETH→${flashInfo.symbol}] 3-hop`;
        const result = await this._evaluateThreeHop(flashAsset, flashInfo.decimals, bestLeg1, bestLeg2, bestLeg3, label3);
        if (result) opportunities.push(result);
      }
    }

    opportunities.sort((a, b) => b.estimatedNetProfitUsd - a.estimatedNetProfitUsd);
    this.logger.info('WETH sandwich scan complete', {
      candidatesEvaluated: candidateCount,
      opportunities: opportunities.length,
    });
    return opportunities;
  }

  private async _evaluateSandwich(
    flashAsset: string,
    flashDecimals: number,
    buyEdge: GraphEdge,
    sellEdge: GraphEdge,
    label: string
  ): Promise<ArbitragePath | null> {
    const flashAmount = this._getFlashAmount(buyEdge, flashAsset, flashDecimals);
    if (flashAmount === 0n) return null;

    const wethAmount = this._simulateEdge(buyEdge, flashAmount, flashDecimals, 18);
    if (wethAmount === 0n) return null;

    const returnAmount = this._simulateEdge(sellEdge, wethAmount, 18, flashDecimals);
    if (returnAmount === 0n) return null;

    const edges  = [buyEdge, sellEdge];
    const profit = await this.estimateNetProfitUsd(flashAsset, flashAmount, returnAmount, flashDecimals, edges, label);
    if (profit.netProfitUsd <= 0) return null;

    return this.createArbitragePath(edges, flashAsset, flashAmount, returnAmount,
      profit.grossProfitUsd, profit.gasCostUsd, profit.netProfitUsd, this.id);
  }

  private async _evaluateThreeHop(
    flashAsset: string,
    flashDecimals: number,
    leg1: GraphEdge,
    leg2: GraphEdge,
    leg3: GraphEdge,
    label: string
  ): Promise<ArbitragePath | null> {
    const flashAmount = this._getFlashAmount(leg1, flashAsset, flashDecimals);
    if (flashAmount === 0n) return null;

    const midToken   = leg1.to;
    const midInfo    = TOKEN_BY_ADDRESS[midToken.toLowerCase()];
    const midDecimals = midInfo?.decimals ?? 18;

    const midAmount  = this._simulateEdge(leg1, flashAmount, flashDecimals, midDecimals);
    if (midAmount === 0n) return null;

    const wethAmount = this._simulateEdge(leg2, midAmount, midDecimals, 18);
    if (wethAmount === 0n) return null;

    const returnAmount = this._simulateEdge(leg3, wethAmount, 18, flashDecimals);
    if (returnAmount === 0n) return null;

    const edges  = [leg1, leg2, leg3];
    const profit = await this.estimateNetProfitUsd(flashAsset, flashAmount, returnAmount, flashDecimals, edges, label);
    if (profit.netProfitUsd <= 0) return null;

    return this.createArbitragePath(edges, flashAsset, flashAmount, returnAmount,
      profit.grossProfitUsd, profit.gasCostUsd, profit.netProfitUsd, this.id);
  }

  /**
   * Simulates a single swap edge with correct math for V2 and V3.
   * @param edge The pool edge
   * @param amountIn Input amount in tokenIn native units
   * @param decimalsIn Input token decimals
   * @param decimalsOut Output token decimals
   */
  private _simulateEdge(
    edge: GraphEdge,
    amountIn: bigint,
    decimalsIn: number,
    decimalsOut: number
  ): bigint {
    try {
      if (amountIn === 0n) return 0n;

      // V2-style pool (has reserves)
      if (edge.reserve0 && edge.reserve1 && edge.reserve0 > 0n && edge.reserve1 > 0n) {
        const isToken0In = edge.from < edge.to;
        const reserveIn  = isToken0In ? edge.reserve0 : edge.reserve1;
        const reserveOut = isToken0In ? edge.reserve1 : edge.reserve0;
        // fee in bps (e.g. 30 = 0.3%)
        const feeBps = edge.fee <= 10000 ? edge.fee : 30;
        return v2GetAmountOut(amountIn, reserveIn, reserveOut, feeBps);
      }

      // V3-style pool (has sqrtPriceX96)
      if (edge.sqrtPriceX96 && edge.sqrtPriceX96 > 0n) {
        return this._v3SimulateSwap(edge, amountIn, decimalsIn, decimalsOut);
      }

      return 0n;
    } catch {
      return 0n;
    }
  }

  /**
   * V3 swap simulation using sqrtPriceX96.
   * Formula: price = (sqrtPriceX96 / 2^96)^2
   * amountOut = amountIn * price * (1 - fee/1e6) [for zeroForOne]
   * amountOut = amountIn / price * (1 - fee/1e6) [for oneForZero]
   */
  private _v3SimulateSwap(
    edge: GraphEdge,
    amountIn: bigint,
    _decimalsIn: number,
    _decimalsOut: number
  ): bigint {
    if (!edge.sqrtPriceX96 || edge.sqrtPriceX96 === 0n) return 0n;

    const sqrtPrice = edge.sqrtPriceX96;
    // fee is already stored in ppm (e.g. 3000 = 0.3%, 500 = 0.05%, 9 = 0.0009%)
    const feePpm = edge.fee;
    const feeMultiplier = 1_000_000n - BigInt(feePpm);

    // zeroForOne: token0 -> token1 (from < to in address order)
    const zeroForOne = edge.from.toLowerCase() < edge.to.toLowerCase();

    // price = sqrtPrice^2 / 2^192
    // For zeroForOne: amountOut = amountIn * sqrtPrice^2 / 2^192 * (1 - fee)
    // For oneForZero: amountOut = amountIn * 2^192 / sqrtPrice^2 * (1 - fee)

    // sqrtPriceX96 already encodes the raw unit ratio — NO decimal adjustment needed
    // price = sqrtPriceX96^2 / 2^192 = token1_raw / token0_raw

    if (zeroForOne) {
      // Selling token0 for token1
      const numerator = amountIn * sqrtPrice * sqrtPrice * feeMultiplier;
      const denominator = (1n << 192n) * 1_000_000n;
      return numerator / denominator;
    } else {
      // Selling token1 for token0
      const numerator = amountIn * (1n << 192n) * feeMultiplier;
      const denominator = sqrtPrice * sqrtPrice * 1_000_000n;
      if (denominator === 0n) return 0n;
      return numerator / denominator;
    }
  }

  /**
   * Gets a safe flash amount for an edge, applying hard caps.
   */
  private _getFlashAmount(edge: GraphEdge, flashAsset: string, flashDecimals: number): bigint {
    if (edge.reserve0 && edge.reserve1) {
      return safeFlashAmountFromV2Edge(edge, flashAsset, flashDecimals);
    }
    return safeFlashAmountFromV3Edge(flashAsset, flashDecimals);
  }

  /**
   * Validates that an edge has sufficient liquidity and valid price data.
   */
  private _isEdgeValid(edge: GraphEdge, tokenDecimals: number): boolean {
    if (edge.reserve0 && edge.reserve1) {
      return hasMinimumV2Liquidity(edge, tokenDecimals);
    }
    if (edge.sqrtPriceX96) {
      return hasValidV3Price(edge);
    }
    return false;
  }

  private _pickBestEdge(edges: GraphEdge[]): GraphEdge | null {
    if (edges.length === 0) return null;
    // Prefer edges with valid price data
    const valid = edges.filter(e => this._isEdgeValid(e, 18));
    if (valid.length === 0) return null;
    return valid.reduce((best, edge) => edge.weight < best.weight ? edge : best, valid[0]);
  }
}