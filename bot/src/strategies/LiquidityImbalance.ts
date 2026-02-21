/**
 * @file LiquidityImbalance.ts
 * @description Strategy 5: Liquidity Imbalance. Detects when a large pool and a small pool for
 *              the same pair have divergent prices due to reserve ratio differences. Buys on the
 *              pool with the better rate, sells on the other.
 */

import { BaseStrategy } from './BaseStrategy';
import { pairKey } from '../utils/addressUtils';
import { getAmountOut as v2GetAmountOut } from '../dex/math/V2Math';
import { TOKEN_BY_ADDRESS } from '../config/addresses';
import type { ArbitragePath, GraphEdge } from '../graph/types';
import type { PoolEntry } from '../discovery/types';

export class LiquidityImbalance extends BaseStrategy {
  readonly name = 'Liquidity Imbalance';
  readonly id = 'liquidity-imbalance';

  async findOpportunities(): Promise<ArbitragePath[]> {
    const opportunities: ArbitragePath[] = [];
    const pools = this.registry.pools;

    // Group pools by token pair
    const pairPools = new Map<string, PoolEntry[]>();
    for (const pool of Object.values(pools)) {
      const key = pairKey(pool.token0.address, pool.token1.address);
      if (!pairPools.has(key)) pairPools.set(key, []);
      pairPools.get(key)!.push(pool);
    }

    for (const [, poolGroup] of pairPools) {
      if (poolGroup.length < 2) continue;

      // Sort pools by liquidity (descending)
      const sortedPools = this._sortByLiquidity(poolGroup);

      // Compare large pools vs small pools
      for (let i = 0; i < sortedPools.length; i++) {
        for (let j = i + 1; j < sortedPools.length; j++) {
          const largePool = sortedPools[i];
          const smallPool = sortedPools[j];

          // Check liquidity ratio - we want significant imbalance
          const largeReserve = this._getTotalReserve(largePool);
          const smallReserve = this._getTotalReserve(smallPool);

          if (largeReserve === 0n || smallReserve === 0n) continue;
          if (largeReserve < smallReserve * 5n) continue; // Need at least 5x difference

          // Check both directions
          const result1 = await this._checkImbalance(largePool, smallPool);
          if (result1) opportunities.push(result1);

          const result2 = await this._checkImbalance(smallPool, largePool);
          if (result2) opportunities.push(result2);
        }
      }
    }

    opportunities.sort((a, b) => b.estimatedNetProfitUsd - a.estimatedNetProfitUsd);
    this.logger.info('Liquidity imbalance scan complete', { opportunities: opportunities.length });
    return opportunities;
  }

  private async _checkImbalance(buyPool: PoolEntry, sellPool: PoolEntry): Promise<ArbitragePath | null> {
    const flashAsset = buyPool.aaveAsset;
    if (!flashAsset) return null;

    const tokenInfo = TOKEN_BY_ADDRESS[flashAsset.toLowerCase()];
    if (!tokenInfo) return null;

    const isBuyToken0 = buyPool.token0.address.toLowerCase() === flashAsset.toLowerCase();
    const tokenA = isBuyToken0 ? buyPool.token1.address : buyPool.token0.address;
    const tokenB = flashAsset;

    const flashAmount = this._estimateTradeSize(buyPool, flashAsset, tokenInfo.decimals);
    if (flashAmount === 0n) return null;

    const buyOutput = this._simulateSwap(buyPool, tokenB, tokenA, flashAmount);
    if (buyOutput === 0n) return null;

    const sellOutput = this._simulateSwap(sellPool, tokenA, tokenB, buyOutput);
    if (sellOutput === 0n) return null;

    const premium = (flashAmount * 5n) / 10000n;
    if (sellOutput <= flashAmount + premium) return null;

    const edges: GraphEdge[] = [
      this._poolToEdge(buyPool, tokenB, tokenA),
      this._poolToEdge(sellPool, tokenA, tokenB),
    ];

    const profit = await this.estimateNetProfitUsd(flashAsset, flashAmount, sellOutput, tokenInfo.decimals, edges);
    if (profit.netProfitUsd < this.config.minProfitThresholdUsd) return null;

    return this.createArbitragePath(edges, flashAsset, flashAmount, sellOutput, profit.grossProfitUsd, profit.gasCostUsd, profit.netProfitUsd, this.id);
  }

  private _sortByLiquidity(pools: PoolEntry[]): PoolEntry[] {
    return [...pools].sort((a, b) => {
      const la = this._getTotalReserve(a);
      const lb = this._getTotalReserve(b);
      return la > lb ? -1 : la < lb ? 1 : 0;
    });
  }

  private _getTotalReserve(pool: PoolEntry): bigint {
    if (pool.reserve0 && pool.reserve1) {
      return BigInt(pool.reserve0) + BigInt(pool.reserve1);
    }
    if (pool.liquidity) return BigInt(pool.liquidity);
    return 0n;
  }

  private _simulateSwap(pool: PoolEntry, tokenIn: string, tokenOut: string, amountIn: bigint): bigint {
    try {
      if (pool.reserve0 && pool.reserve1) {
        const r0 = BigInt(pool.reserve0); const r1 = BigInt(pool.reserve1);
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

  private _getDexId(n: string): number {
    const m: Record<string, number> = { 'Uniswap V2': 0, 'Uniswap V3': 1, 'SushiSwap V2': 2, 'SushiSwap V3': 3, 'Aerodrome': 4, 'Aerodrome Slipstream': 5, 'BaseSwap V2': 6, 'BaseSwap V3': 7, 'SwapBased': 8, 'PancakeSwap V3': 9 };
    return m[n] ?? 0;
  }
}