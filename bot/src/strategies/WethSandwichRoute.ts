/**
 * @file WethSandwichRoute.ts
 * @description Strategy 7: WETH Sandwich Route. Constructs multi-hop paths that use WETH as an
 *              intermediate token. Flash borrows a non-WETH Aave asset, swaps to WETH on one DEX,
 *              then swaps WETH back to the flash asset on another DEX, profiting from price
 *              differences in the WETH intermediate legs.
 */

import { BaseStrategy } from './BaseStrategy';
import { TOKENS, TOKEN_BY_ADDRESS } from '../config/addresses';
import { getAmountOut as v2GetAmountOut } from '../dex/math/V2Math';
import type { ArbitragePath, GraphEdge } from '../graph/types';
import type { PoolEntry } from '../discovery/types';

export class WethSandwichRoute extends BaseStrategy {
  readonly name = 'WETH Sandwich Route';
  readonly id = 'weth-sandwich';

  async findOpportunities(): Promise<ArbitragePath[]> {
    const opportunities: ArbitragePath[] = [];
    const wethAddress = TOKENS.WETH.address.toLowerCase();
    const aaveAssets = this.registry.meta.aaveAssets;

    for (const flashAsset of aaveAssets) {
      const flashLower = flashAsset.toLowerCase();
      if (flashLower === wethAddress) continue; // Skip WETH as flash asset for this strategy

      const flashInfo = TOKEN_BY_ADDRESS[flashLower];
      if (!flashInfo) continue;

      // Find all pools: flashAsset <-> WETH
      const leg1Edges = this.graph.getEdgesBetween(flashLower, wethAddress);
      const leg2Edges = this.graph.getEdgesBetween(wethAddress, flashLower);

      if (leg1Edges.length === 0 || leg2Edges.length === 0) continue;

      // Try all combinations of leg1 and leg2 pools
      for (const buyEdge of leg1Edges) {
        for (const sellEdge of leg2Edges) {
          // Must be different pools
          if (buyEdge.poolAddress === sellEdge.poolAddress) continue;

          const result = await this._evaluateSandwich(flashAsset, flashInfo.decimals, buyEdge, sellEdge);
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

        // Pick best edge for each leg
        const bestLeg1 = this._pickBestEdge(leg1);
        const bestLeg2 = this._pickBestEdge(leg2);
        const bestLeg3 = this._pickBestEdge(leg3);

        if (!bestLeg1 || !bestLeg2 || !bestLeg3) continue;

        // Ensure no duplicate pools
        const pools = new Set([bestLeg1.poolAddress, bestLeg2.poolAddress, bestLeg3.poolAddress]);
        if (pools.size < 3) continue;

        const result = await this._evaluateThreeHop(
          flashAsset, flashInfo.decimals, bestLeg1, bestLeg2, bestLeg3
        );
        if (result) opportunities.push(result);
      }
    }

    opportunities.sort((a, b) => b.estimatedNetProfitUsd - a.estimatedNetProfitUsd);
    this.logger.info('WETH sandwich scan complete', { opportunities: opportunities.length });
    return opportunities;
  }

  private async _evaluateSandwich(
    flashAsset: string,
    flashDecimals: number,
    buyEdge: GraphEdge,
    sellEdge: GraphEdge
  ): Promise<ArbitragePath | null> {
    const flashAmount = this._estimateFlashAmount(buyEdge, flashAsset, flashDecimals);
    if (flashAmount === 0n) return null;

    // Step 1: flashAsset -> WETH
    const wethAmount = this._simulateEdge(buyEdge, flashAmount);
    if (wethAmount === 0n) return null;

    // Step 2: WETH -> flashAsset
    const returnAmount = this._simulateEdge(sellEdge, wethAmount);
    if (returnAmount === 0n) return null;

    const premium = (flashAmount * 5n) / 10000n;
    if (returnAmount <= flashAmount + premium) return null;

    const edges = [buyEdge, sellEdge];
    const profit = await this.estimateNetProfitUsd(flashAsset, flashAmount, returnAmount, flashDecimals, edges);
    if (profit.netProfitUsd < this.config.minProfitThresholdUsd) return null;

    return this.createArbitragePath(edges, flashAsset, flashAmount, returnAmount, profit.grossProfitUsd, profit.gasCostUsd, profit.netProfitUsd, this.id);
  }

  private async _evaluateThreeHop(
    flashAsset: string,
    flashDecimals: number,
    leg1: GraphEdge,
    leg2: GraphEdge,
    leg3: GraphEdge
  ): Promise<ArbitragePath | null> {
    const flashAmount = this._estimateFlashAmount(leg1, flashAsset, flashDecimals);
    if (flashAmount === 0n) return null;

    const midAmount = this._simulateEdge(leg1, flashAmount);
    if (midAmount === 0n) return null;

    const wethAmount = this._simulateEdge(leg2, midAmount);
    if (wethAmount === 0n) return null;

    const returnAmount = this._simulateEdge(leg3, wethAmount);
    if (returnAmount === 0n) return null;

    const premium = (flashAmount * 5n) / 10000n;
    if (returnAmount <= flashAmount + premium) return null;

    const edges = [leg1, leg2, leg3];
    const profit = await this.estimateNetProfitUsd(flashAsset, flashAmount, returnAmount, flashDecimals, edges);
    if (profit.netProfitUsd < this.config.minProfitThresholdUsd) return null;

    return this.createArbitragePath(edges, flashAsset, flashAmount, returnAmount, profit.grossProfitUsd, profit.gasCostUsd, profit.netProfitUsd, this.id);
  }

  private _simulateEdge(edge: GraphEdge, amountIn: bigint): bigint {
    try {
      if (edge.reserve0 && edge.reserve1) {
        const isToken0In = edge.from < edge.to;
        const reserveIn = isToken0In ? edge.reserve0 : edge.reserve1;
        const reserveOut = isToken0In ? edge.reserve1 : edge.reserve0;
        const fee = edge.fee <= 100 ? edge.fee : 30;
        return v2GetAmountOut(amountIn, reserveIn, reserveOut, fee);
      }
      if (edge.sqrtPriceX96 && edge.sqrtPriceX96 > 0n) {
        const fee = edge.fee > 100 ? edge.fee : 3000;
        const zeroForOne = edge.from < edge.to;
        const amountInAfterFee = (amountIn * BigInt(1000000 - fee)) / 1000000n;
        if (zeroForOne) return (amountInAfterFee * edge.sqrtPriceX96 * edge.sqrtPriceX96) >> 192n;
        const priceNum = edge.sqrtPriceX96 * edge.sqrtPriceX96;
        if (priceNum === 0n) return 0n;
        return (amountInAfterFee << 192n) / priceNum;
      }
      return 0n;
    } catch { return 0n; }
  }

  private _estimateFlashAmount(edge: GraphEdge, flashAsset: string, decimals: number): bigint {
    if (edge.reserve0 && edge.reserve1) {
      const isToken0 = edge.from === flashAsset.toLowerCase();
      const reserve = isToken0 ? edge.reserve0 : edge.reserve1;
      return reserve > 0n ? reserve / 50n : 0n;
    }
    return 10n ** BigInt(decimals) * 1000n;
  }

  private _pickBestEdge(edges: GraphEdge[]): GraphEdge | null {
    if (edges.length === 0) return null;
    return edges.reduce((best, edge) => edge.weight < best.weight ? edge : best, edges[0]);
  }
}