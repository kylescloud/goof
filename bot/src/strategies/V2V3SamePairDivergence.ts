/**
 * @file V2V3SamePairDivergence.ts
 * @description Strategy 3: V2/V3 Same-Pair Price Divergence. Detects when the same token pair
 *              has a price discrepancy between a V2 pool and a V3 pool. Buys on the cheaper pool,
 *              sells on the more expensive pool.
 */

import { BaseStrategy } from './BaseStrategy';
import { ProtocolVersion, BPS_BASE } from '../config/constants';
import { pairKey } from '../utils/addressUtils';
import { getAmountOut as v2GetAmountOut, getSpotPrice as v2SpotPrice } from '../dex/math/V2Math';
import { TOKEN_BY_ADDRESS } from '../config/addresses';
import type { ArbitragePath, GraphEdge } from '../graph/types';
import type { PoolEntry } from '../discovery/types';

export class V2V3SamePairDivergence extends BaseStrategy {
  readonly name = 'V2/V3 Same-Pair Divergence';
  readonly id = 'v2v3-divergence';

  async findOpportunities(): Promise<ArbitragePath[]> {
    const opportunities: ArbitragePath[] = [];
    const pools = this.registry.pools;

    // Group pools by token pair
    const pairPools = new Map<string, { v2: PoolEntry[]; v3: PoolEntry[] }>();

    for (const pool of Object.values(pools)) {
      const key = pairKey(pool.token0.address, pool.token1.address);
      if (!pairPools.has(key)) pairPools.set(key, { v2: [], v3: [] });
      const group = pairPools.get(key)!;

      if (pool.version === ProtocolVersion.V2) {
        group.v2.push(pool);
      } else {
        group.v3.push(pool);
      }
    }

    // For each pair with both V2 and V3 pools, check for divergence
    for (const [, group] of pairPools) {
      if (group.v2.length === 0 || group.v3.length === 0) continue;

      for (const v2Pool of group.v2) {
        for (const v3Pool of group.v3) {
          const result = await this._checkDivergence(v2Pool, v3Pool);
          if (result) opportunities.push(result);

          // Also check reverse direction
          const reverseResult = await this._checkDivergence(v3Pool, v2Pool);
          if (reverseResult) opportunities.push(reverseResult);
        }
      }
    }

    opportunities.sort((a, b) => b.estimatedNetProfitUsd - a.estimatedNetProfitUsd);
    this.logger.info('V2/V3 divergence scan complete', { opportunities: opportunities.length });
    return opportunities;
  }

  private async _checkDivergence(buyPool: PoolEntry, sellPool: PoolEntry): Promise<ArbitragePath | null> {
    const flashAsset = buyPool.aaveAsset;
    if (!flashAsset) return null;

    const tokenInfo = TOKEN_BY_ADDRESS[flashAsset.toLowerCase()];
    if (!tokenInfo) return null;

    const isBuyToken0 = buyPool.token0.address.toLowerCase() === flashAsset.toLowerCase();
    const tokenA = isBuyToken0 ? buyPool.token1.address : buyPool.token0.address;
    const tokenB = flashAsset;

    // Get prices from both pools
    const buyPrice = this._getPrice(buyPool, tokenB, tokenA);
    const sellPrice = this._getPrice(sellPool, tokenA, tokenB);

    if (buyPrice === 0n || sellPrice === 0n) return null;

    // Check divergence threshold
    const divergenceBps = this._calculateDivergenceBps(buyPool, sellPool, tokenB, tokenA);
    if (divergenceBps < this.config.v2v3DivergenceThresholdBps) return null;

    // Estimate trade size
    const flashAmount = this._estimateTradeSize(buyPool, flashAsset, tokenInfo.decimals);
    if (flashAmount === 0n) return null;

    // Simulate buy
    const buyOutput = this._simulateSwap(buyPool, tokenB, tokenA, flashAmount);
    if (buyOutput === 0n) return null;

    // Simulate sell
    const sellOutput = this._simulateSwap(sellPool, tokenA, tokenB, buyOutput);
    if (sellOutput === 0n) return null;

    // Check profitability
    const premium = (flashAmount * 5n) / 10000n;
    if (sellOutput <= flashAmount + premium) return null;

    const edges: GraphEdge[] = [
      this._poolToEdge(buyPool, tokenB, tokenA),
      this._poolToEdge(sellPool, tokenA, tokenB),
    ];

    const profit = await this.estimateNetProfitUsd(
      flashAsset, flashAmount, sellOutput, tokenInfo.decimals, edges
    );

    if (profit.netProfitUsd < this.config.minProfitThresholdUsd) return null;

    return this.createArbitragePath(
      edges, flashAsset, flashAmount, sellOutput,
      profit.grossProfitUsd, profit.gasCostUsd, profit.netProfitUsd,
      this.id
    );
  }

  private _calculateDivergenceBps(pool1: PoolEntry, pool2: PoolEntry, tokenIn: string, tokenOut: string): number {
    const testAmount = 10n ** BigInt(TOKEN_BY_ADDRESS[tokenIn.toLowerCase()]?.decimals ?? 18);
    const out1 = this._simulateSwap(pool1, tokenIn, tokenOut, testAmount);
    const out2 = this._simulateSwap(pool2, tokenIn, tokenOut, testAmount);
    if (out1 === 0n || out2 === 0n) return 0;
    const diff = out1 > out2 ? out1 - out2 : out2 - out1;
    const avg = (out1 + out2) / 2n;
    if (avg === 0n) return 0;
    return Number((diff * 10000n) / avg);
  }

  private _getPrice(pool: PoolEntry, tokenIn: string, tokenOut: string): bigint {
    const testAmount = 10n ** BigInt(TOKEN_BY_ADDRESS[tokenIn.toLowerCase()]?.decimals ?? 6) * 100n;
    return this._simulateSwap(pool, tokenIn, tokenOut, testAmount);
  }

  private _simulateSwap(pool: PoolEntry, tokenIn: string, tokenOut: string, amountIn: bigint): bigint {
    try {
      if (pool.reserve0 && pool.reserve1) {
        const r0 = BigInt(pool.reserve0);
        const r1 = BigInt(pool.reserve1);
        if (r0 === 0n || r1 === 0n) return 0n;
        const isToken0In = tokenIn.toLowerCase() === pool.token0.address.toLowerCase();
        return v2GetAmountOut(amountIn, isToken0In ? r0 : r1, isToken0In ? r1 : r0, pool.fee ?? 30);
      }
      if (pool.sqrtPriceX96) {
        const sqrtPrice = BigInt(pool.sqrtPriceX96);
        if (sqrtPrice === 0n) return 0n;
        const fee = pool.fee ?? 3000;
        const zeroForOne = tokenIn.toLowerCase() === pool.token0.address.toLowerCase();
        const amountInAfterFee = (amountIn * BigInt(1000000 - fee)) / 1000000n;
        if (zeroForOne) return (amountInAfterFee * sqrtPrice * sqrtPrice) >> 192n;
        const priceNum = sqrtPrice * sqrtPrice;
        if (priceNum === 0n) return 0n;
        return (amountInAfterFee << 192n) / priceNum;
      }
      return 0n;
    } catch { return 0n; }
  }

  private _estimateTradeSize(pool: PoolEntry, flashAsset: string, decimals: number): bigint {
    if (pool.reserve0 && pool.reserve1) {
      const isToken0 = pool.token0.address.toLowerCase() === flashAsset.toLowerCase();
      const reserve = BigInt(isToken0 ? pool.reserve0 : pool.reserve1);
      return reserve > 0n ? reserve / 50n : 0n;
    }
    return 10n ** BigInt(decimals) * 1000n;
  }

  private _poolToEdge(pool: PoolEntry, from: string, to: string): GraphEdge {
    return {
      from: from.toLowerCase(), to: to.toLowerCase(), poolAddress: pool.address,
      dexId: this._getDexId(pool.dex), dexName: pool.dex, fee: pool.fee ?? 30, weight: 0,
      reserve0: pool.reserve0 ? BigInt(pool.reserve0) : undefined,
      reserve1: pool.reserve1 ? BigInt(pool.reserve1) : undefined,
      sqrtPriceX96: pool.sqrtPriceX96 ? BigInt(pool.sqrtPriceX96) : undefined,
      liquidity: pool.liquidity ? BigInt(pool.liquidity) : undefined,
    };
  }

  private _getDexId(dexName: string): number {
    const map: Record<string, number> = {
      'Uniswap V2': 0, 'Uniswap V3': 1, 'SushiSwap V2': 2, 'SushiSwap V3': 3,
      'Aerodrome': 4, 'Aerodrome Slipstream': 5, 'BaseSwap V2': 6, 'BaseSwap V3': 7,
      'SwapBased': 8, 'PancakeSwap V3': 9,
    };
    return map[dexName] ?? 0;
  }
}