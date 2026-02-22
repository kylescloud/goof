/**
 * @file ThreeHopTriangular.ts
 * @description Strategy 2: Three-Hop Triangular Arbitrage. Flash borrow token A, swap A→B on DEX1,
 *              B→C on DEX2, C→A on DEX3. Uses beam search to find the most profitable triangular
 *              paths across all DEX combinations.
 *
 *              VERBOSE: Logs every candidate path scanned with full profit/loss details.
 */

import { BaseStrategy } from './BaseStrategy';
import { BeamSearch } from '../graph/BeamSearch';
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

    this.logger.info(`Scanning ${aaveAssets.length} Aave assets for three-hop triangular paths`);

    let candidateCount = 0;

    for (const flashAsset of aaveAssets) {
      const flashAssetLower = flashAsset.toLowerCase();
      if (!this.graph.hasToken(flashAssetLower)) {
        this.logger.debug(`Skip: token ${flashAssetLower.slice(0,10)} not in graph`);
        continue;
      }

      const paths = beamSearch.search(flashAssetLower, 50);
      this.logger.debug(`BeamSearch found ${paths.length} paths from ${flashAssetLower.slice(0,10)}`);

      for (const edges of paths) {
        if (edges.length !== 3) continue; // Strictly 3 hops

        // Ensure all three pools are different
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
        const hopDetails: string[] = [];

        for (const edge of edges) {
          const prevAmount = currentAmount;
          const adapter = this.dexRegistry.getAdapter(edge.dexId);
          if (!adapter) { failed = true; break; }

          try {
            currentAmount = await adapter.getAmountOut({
              tokenIn:  edge.from,
              tokenOut: edge.to,
              amountIn: currentAmount,
              pool:     edge.poolAddress,
              fee:      edge.fee,
            });
          } catch {
            // Fallback to local simulation
            currentAmount = this._localSimulate(edge, currentAmount);
          }

          hopDetails.push(`${edge.dexName}(${edge.poolAddress.slice(0,8)}): ${prevAmount}→${currentAmount}`);
          if (currentAmount === 0n) { failed = true; break; }
        }

        if (failed || currentAmount === 0n) {
          this.logger.debug(`Skip: simulation failed for path`, { hops: hopDetails.join(' | ') });
          continue;
        }

        candidateCount++;
        const pathLabel = edges.map(e => e.dexName).join('→');
        const label = `#${candidateCount} [${tokenInfo.symbol}] ${pathLabel}`;

        // Full profit calculation (logs candidate details)
        const profit = await this.estimateNetProfitUsd(
          flashAsset, flashAmount, currentAmount, tokenInfo.decimals, edges, label
        );

        if (profit.netProfitUsd <= 0) continue;

        opportunities.push(this.createArbitragePath(
          edges, flashAsset, flashAmount, currentAmount,
          profit.grossProfitUsd, profit.gasCostUsd, profit.netProfitUsd,
          this.id
        ));
      }
    }

    opportunities.sort((a, b) => b.estimatedNetProfitUsd - a.estimatedNetProfitUsd);
    this.logger.info('Three-hop triangular scan complete', {
      aaveAssets: aaveAssets.length,
      candidatesEvaluated: candidateCount,
      opportunities: opportunities.length,
    });
    return opportunities;
  }

  private _localSimulate(edge: GraphEdge, amountIn: bigint): bigint {
    try {
      if (amountIn === 0n) return 0n;

      if (edge.reserve0 && edge.reserve1) {
        const isToken0In = edge.from < edge.to;
        const reserveIn  = isToken0In ? edge.reserve0 : edge.reserve1;
        const reserveOut = isToken0In ? edge.reserve1 : edge.reserve0;
        if (reserveIn === 0n || reserveOut === 0n) return 0n;
        const feeBps = edge.fee <= 10000 ? edge.fee : 30;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getAmountOut } = require('../dex/math/V2Math');
        return getAmountOut(amountIn, reserveIn, reserveOut, feeBps);
      }

      if (edge.sqrtPriceX96 && edge.sqrtPriceX96 > 0n) {
        // edge.fee is already stored in ppm (e.g. 3000 = 0.3%, 500 = 0.05%, 9 = 0.0009%)
        const feePpm = edge.fee;
        const feeMultiplier = 1_000_000n - BigInt(feePpm);
        const zeroForOne = edge.from.toLowerCase() < edge.to.toLowerCase();

        // For triangular arb, tokens in the same path typically have same decimals
        // Use 1:1 decimal ratio (no adjustment needed for same-decimal pairs)
        if (zeroForOne) {
          const numerator = amountIn * edge.sqrtPriceX96 * edge.sqrtPriceX96 * feeMultiplier;
          const denominator = (1n << 192n) * 1_000_000n;
          return numerator / denominator;
        } else {
          const priceNum = edge.sqrtPriceX96 * edge.sqrtPriceX96;
          if (priceNum === 0n) return 0n;
          const numerator = amountIn * (1n << 192n) * feeMultiplier;
          const denominator = priceNum * 1_000_000n;
          return numerator / denominator;
        }
      }
      return 0n;
    } catch { return 0n; }
  }
}