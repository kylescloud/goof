/**
 * @file ThreeHopTriangular.ts
 * @description Strategy 2: Three-Hop Triangular Arbitrage. Flash borrow token A, swap A→B on DEX1,
 *              B→C on DEX2, C→A on DEX3. Uses beam search to find the most profitable triangular
 *              paths across all DEX combinations.
 */

import { BaseStrategy } from './BaseStrategy';
import { BeamSearch } from '../graph/BeamSearch';
import { TOKENS } from '../config/addresses';
import { TOKEN_BY_ADDRESS } from '../config/addresses';
import type { ArbitragePath, GraphEdge } from '../graph/types';

export class ThreeHopTriangular extends BaseStrategy {
  readonly name = 'Three-Hop Triangular';
  readonly id = 'three-hop-triangular';

  async findOpportunities(): Promise<ArbitragePath[]> {
    const opportunities: ArbitragePath[] = [];
    const beamSearch = new BeamSearch(this.graph, this.config.beamWidth, 3);

    // Run beam search from each Aave-eligible token
    const aaveAssets = this.registry.meta.aaveAssets;

    for (const flashAsset of aaveAssets) {
      const flashAssetLower = flashAsset.toLowerCase();
      if (!this.graph.hasToken(flashAssetLower)) continue;

      const paths = beamSearch.search(flashAssetLower, 50);

      for (const edges of paths) {
        if (edges.length !== 3) continue; // Strictly 3 hops

        // Ensure all three DEXes are different (true triangular)
        const dexes = new Set(edges.map((e) => e.dexId));
        // Allow same DEX if different pools
        const pools = new Set(edges.map((e) => e.poolAddress));
        if (pools.size < 3) continue;

        // Get flash asset info
        const tokenInfo = TOKEN_BY_ADDRESS[flashAssetLower];
        if (!tokenInfo) continue;

        const flashAmount = this.estimateFlashLoanAmount(edges, tokenInfo.decimals);
        if (flashAmount === 0n) continue;

        // Simulate the three-hop path
        let currentAmount = flashAmount;
        let failed = false;

        for (const edge of edges) {
          const adapter = this.dexRegistry.getAdapter(edge.dexId);
          if (!adapter) { failed = true; break; }

          try {
            currentAmount = await adapter.getAmountOut({
              tokenIn: edge.from,
              tokenOut: edge.to,
              amountIn: currentAmount,
              pool: edge.poolAddress,
              fee: edge.fee,
            });
          } catch {
            // Fallback to local simulation
            currentAmount = this._localSimulate(edge, currentAmount);
          }

          if (currentAmount === 0n) { failed = true; break; }
        }

        if (failed || currentAmount === 0n) continue;

        // Check profitability
        const premium = (flashAmount * 5n) / 10000n;
        const totalRepayment = flashAmount + premium;
        if (currentAmount <= totalRepayment) continue;

        const profit = await this.estimateNetProfitUsd(
          flashAsset, flashAmount, currentAmount, tokenInfo.decimals, edges
        );

        if (profit.netProfitUsd < this.config.minProfitThresholdUsd) continue;

        opportunities.push(this.createArbitragePath(
          edges, flashAsset, flashAmount, currentAmount,
          profit.grossProfitUsd, profit.gasCostUsd, profit.netProfitUsd,
          this.id
        ));
      }
    }

    opportunities.sort((a, b) => b.estimatedNetProfitUsd - a.estimatedNetProfitUsd);
    this.logger.info('Three-hop triangular scan complete', { opportunities: opportunities.length });
    return opportunities;
  }

  private _localSimulate(edge: GraphEdge, amountIn: bigint): bigint {
    try {
      if (edge.reserve0 && edge.reserve1) {
        const isToken0In = edge.from < edge.to;
        const reserveIn = isToken0In ? edge.reserve0 : edge.reserve1;
        const reserveOut = isToken0In ? edge.reserve1 : edge.reserve0;
        const fee = edge.fee <= 100 ? edge.fee : 30;
        const { getAmountOut } = require('../dex/math/V2Math');
        return getAmountOut(amountIn, reserveIn, reserveOut, fee);
      }

      if (edge.sqrtPriceX96 && edge.sqrtPriceX96 > 0n) {
        const fee = edge.fee > 100 ? edge.fee : 3000;
        const zeroForOne = edge.from < edge.to;
        const amountInAfterFee = (amountIn * BigInt(1000000 - fee)) / 1000000n;
        if (zeroForOne) {
          return (amountInAfterFee * edge.sqrtPriceX96 * edge.sqrtPriceX96) >> 192n;
        } else {
          const priceNum = edge.sqrtPriceX96 * edge.sqrtPriceX96;
          if (priceNum === 0n) return 0n;
          return (amountInAfterFee << 192n) / priceNum;
        }
      }
      return 0n;
    } catch { return 0n; }
  }
}