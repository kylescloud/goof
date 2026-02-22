/**
 * @file ZeroXVsDirectRoute.ts
 * @description Strategy 6: 0x Aggregator vs Direct Route. Fetches a 0x quote for a token pair,
 *              then compares it against the best direct DEX route. If the 0x quote is significantly
 *              better or worse, constructs an arb path using the cheaper route for buying and the
 *              more expensive route for selling.
 *
 *              VERBOSE: Logs every candidate path scanned with full profit/loss details.
 */

import { BaseStrategy } from './BaseStrategy';
import { DexId } from '../config/constants';
import { TOKEN_BY_ADDRESS } from '../config/addresses';
import { ZeroXAdapter } from '../dex/adapters/ZeroXAdapter';
import type { ArbitragePath, GraphEdge } from '../graph/types';

export class ZeroXVsDirectRoute extends BaseStrategy {
  readonly name = '0x vs Direct Route';
  readonly id = 'zerox-vs-direct';
  private zeroXAdapter: ZeroXAdapter | null;

  constructor(...args: ConstructorParameters<typeof BaseStrategy>) {
    super(...args);
    this.zeroXAdapter = null;
  }

  setZeroXAdapter(adapter: ZeroXAdapter): void {
    this.zeroXAdapter = adapter;
  }

  async findOpportunities(): Promise<ArbitragePath[]> {
    if (!this.zeroXAdapter || !this.config.zeroXApiKey) {
      this.logger.debug('0x adapter not configured, skipping strategy');
      return [];
    }

    const opportunities: ArbitragePath[] = [];
    const aaveAssets = this.registry.meta.aaveAssets;

    this.logger.info(`Scanning ${aaveAssets.length} Aave assets for 0x vs direct route opportunities`);

    let candidateCount = 0;

    for (const flashAsset of aaveAssets) {
      const flashInfo = TOKEN_BY_ADDRESS[flashAsset.toLowerCase()];
      if (!flashInfo) continue;

      const neighbors = this.graph.getNeighbors(flashAsset.toLowerCase());

      for (const targetToken of neighbors) {
        const targetInfo = TOKEN_BY_ADDRESS[targetToken.toLowerCase()];
        if (!targetInfo) continue;
        if (targetToken.toLowerCase() === flashAsset.toLowerCase()) continue;

        candidateCount++;
        const label = `#${candidateCount} [${flashInfo.symbol}→${targetInfo.symbol}] 0x vs direct`;

        try {
          const result = await this._compareRoutes(flashAsset, targetToken, flashInfo.decimals, targetInfo.decimals, label);
          if (result) opportunities.push(result);
        } catch (error) {
          this.logger.debug('0x comparison failed', {
            flashAsset: flashInfo.symbol,
            target: targetInfo.symbol,
            error: (error as Error).message,
          });
        }
      }
    }

    opportunities.sort((a, b) => b.estimatedNetProfitUsd - a.estimatedNetProfitUsd);
    this.logger.info('0x vs direct route scan complete', {
      candidatesEvaluated: candidateCount,
      opportunities: opportunities.length,
    });
    return opportunities;
  }

  private async _compareRoutes(
    flashAsset: string,
    targetToken: string,
    flashDecimals: number,
    targetDecimals: number,
    label: string
  ): Promise<ArbitragePath | null> {
    const flashAmount = 10n ** BigInt(flashDecimals) * 1000n; // $1000 equivalent

    // Get best direct DEX route: flash -> target
    const directEdges = this.graph.getEdgesBetween(flashAsset.toLowerCase(), targetToken.toLowerCase());
    if (directEdges.length === 0) return null;

    let bestDirectOut = 0n;
    let bestDirectEdge: GraphEdge | null = null;

    for (const edge of directEdges) {
      try {
        const adapter = this.dexRegistry.getAdapter(edge.dexId);
        if (!adapter) continue;
        const out = await adapter.getAmountOut({
          tokenIn: flashAsset, tokenOut: targetToken,
          amountIn: flashAmount, pool: edge.poolAddress, fee: edge.fee,
        });
        if (out > bestDirectOut) {
          bestDirectOut  = out;
          bestDirectEdge = edge;
        }
      } catch { continue; }
    }

    if (!bestDirectEdge || bestDirectOut === 0n) return null;

    // Get 0x quote: flash -> target
    const zeroXPrice = await this.zeroXAdapter!.getPrice(flashAsset, targetToken, flashAmount);
    if (!zeroXPrice || zeroXPrice.buyAmount === 0n) return null;

    const zeroXOut = zeroXPrice.buyAmount;
    const flashInfo  = TOKEN_BY_ADDRESS[flashAsset.toLowerCase()];
    const targetInfo = TOKEN_BY_ADDRESS[targetToken.toLowerCase()];

    this.logger.debug(`0x vs direct [${flashInfo?.symbol}→${targetInfo?.symbol}]`, {
      directOut: bestDirectOut.toString().slice(0, 12),
      zeroXOut:  zeroXOut.toString().slice(0, 12),
      directDex: bestDirectEdge.dexName,
    });

    if (zeroXOut > bestDirectOut) {
      // 0x is cheaper to buy target → buy via 0x, sell on DEX
      const reverseEdges = this.graph.getEdgesBetween(targetToken.toLowerCase(), flashAsset.toLowerCase());
      if (reverseEdges.length === 0) return null;

      let bestReverseOut  = 0n;
      let bestReverseEdge: GraphEdge | null = null;

      for (const edge of reverseEdges) {
        try {
          const adapter = this.dexRegistry.getAdapter(edge.dexId);
          if (!adapter) continue;
          const out = await adapter.getAmountOut({
            tokenIn: targetToken, tokenOut: flashAsset,
            amountIn: zeroXOut, pool: edge.poolAddress, fee: edge.fee,
          });
          if (out > bestReverseOut) {
            bestReverseOut  = out;
            bestReverseEdge = edge;
          }
        } catch { continue; }
      }

      if (!bestReverseEdge || bestReverseOut === 0n) return null;

      const edges: GraphEdge[] = [
        { from: flashAsset.toLowerCase(), to: targetToken.toLowerCase(), poolAddress: '0x', dexId: DexId.ZERO_X, dexName: '0x', fee: 0, weight: 0 },
        bestReverseEdge,
      ];

      const profit = await this.estimateNetProfitUsd(flashAsset, flashAmount, bestReverseOut, flashDecimals, edges, `${label} [0x-buy]`);
      if (profit.netProfitUsd <= 0) return null;

      return this.createArbitragePath(edges, flashAsset, flashAmount, bestReverseOut,
        profit.grossProfitUsd, profit.gasCostUsd, profit.netProfitUsd, this.id);

    } else if (bestDirectOut > zeroXOut) {
      // Direct DEX is cheaper → buy on DEX, sell via 0x
      const zeroXSellPrice = await this.zeroXAdapter!.getPrice(targetToken, flashAsset, bestDirectOut);
      if (!zeroXSellPrice || zeroXSellPrice.buyAmount === 0n) return null;

      const sellReturn = zeroXSellPrice.buyAmount;

      const edges: GraphEdge[] = [
        bestDirectEdge,
        { from: targetToken.toLowerCase(), to: flashAsset.toLowerCase(), poolAddress: '0x', dexId: DexId.ZERO_X, dexName: '0x', fee: 0, weight: 0 },
      ];

      const profit = await this.estimateNetProfitUsd(flashAsset, flashAmount, sellReturn, flashDecimals, edges, `${label} [dex-buy]`);
      if (profit.netProfitUsd <= 0) return null;

      return this.createArbitragePath(edges, flashAsset, flashAmount, sellReturn,
        profit.grossProfitUsd, profit.gasCostUsd, profit.netProfitUsd, this.id);
    }

    return null;
  }
}