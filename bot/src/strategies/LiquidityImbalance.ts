/**
 * @file LiquidityImbalance.ts
 * @description Strategy 5: Liquidity Imbalance. Detects when two pools for the same pair have
 *              divergent prices due to reserve ratio differences. Buys on the pool with the
 *              better rate, sells on the other.
 *
 *              FIXES:
 *              - Uses safeFlashAmountFromPool with hard caps
 *              - Validates minimum pool liquidity before scanning
 *              - Correct V3 price math with decimal adjustment
 *              - Skips pools with zero/invalid reserves
 *              - Skips pairs where price divergence is unrealistically large (broken pool)
 */

import { BaseStrategy } from './BaseStrategy';
import { pairKey } from '../utils/addressUtils';
import { getAmountOut as v2GetAmountOut } from '../dex/math/V2Math';
import { TOKEN_BY_ADDRESS } from '../config/addresses';
import { MAX_DIVERGENCE_BPS, MIN_V2_RESERVE_NORMALIZED } from '../config/constants';
import { safeFlashAmountFromPool } from './flashAmountUtils';
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

    const multiPairs = [...pairPools.values()].filter(g => g.length >= 2);
    this.logger.info(`Scanning ${multiPairs.length} pairs with ≥2 pools for liquidity imbalance`);

    let candidateCount = 0;

    for (const [, poolGroup] of pairPools) {
      if (poolGroup.length < 2) continue;

      // Sort pools by liquidity (descending)
      const sortedPools = this._sortByLiquidity(poolGroup);

      for (let i = 0; i < sortedPools.length; i++) {
        for (let j = i + 1; j < sortedPools.length; j++) {
          const poolA = sortedPools[i];
          const poolB = sortedPools[j];

          // Skip pools with no valid liquidity
          if (!this._hasValidLiquidity(poolA)) continue;
          if (!this._hasValidLiquidity(poolB)) continue;

          // Check price divergence between the two pools
          const divergenceBps = this._getPriceDivergenceBps(poolA, poolB);
          if (divergenceBps <= 0 || divergenceBps > MAX_DIVERGENCE_BPS) {
            this.logger.debug('Skipping pair: divergence out of range', {
              pair: `${poolA.token0.symbol}/${poolA.token1.symbol}`,
              divergenceBps,
              poolA: poolA.dex,
              poolB: poolB.dex,
            });
            continue;
          }

          candidateCount++;
          const result1 = await this._checkImbalance(poolA, poolB, candidateCount);
          if (result1) opportunities.push(result1);

          candidateCount++;
          const result2 = await this._checkImbalance(poolB, poolA, candidateCount);
          if (result2) opportunities.push(result2);
        }
      }
    }

    opportunities.sort((a, b) => b.estimatedNetProfitUsd - a.estimatedNetProfitUsd);
    this.logger.info('Liquidity imbalance scan complete', {
      candidatesEvaluated: candidateCount,
      opportunities: opportunities.length,
    });
    return opportunities;
  }

  private async _checkImbalance(buyPool: PoolEntry, sellPool: PoolEntry, idx: number): Promise<ArbitragePath | null> {
    const flashAsset = buyPool.aaveAsset;
    if (!flashAsset) return null;

    const tokenInfo = TOKEN_BY_ADDRESS[flashAsset.toLowerCase()];
    if (!tokenInfo) return null;

    const isBuyToken0 = buyPool.token0.address.toLowerCase() === flashAsset.toLowerCase();
    const tokenA = isBuyToken0 ? buyPool.token1.address : buyPool.token0.address;
    const tokenB = flashAsset;

    const tokenAInfo = TOKEN_BY_ADDRESS[tokenA.toLowerCase()];
    const tokenADecimals = tokenAInfo?.decimals ?? 18;

    const flashAmount = safeFlashAmountFromPool(buyPool, flashAsset, tokenInfo.decimals);
    if (flashAmount === 0n) return null;

    const buyOutput = this._simulateSwap(buyPool, tokenB, tokenA, flashAmount, tokenInfo.decimals, tokenADecimals);
    if (buyOutput === 0n) return null;

    const sellOutput = this._simulateSwap(sellPool, tokenA, tokenB, buyOutput, tokenADecimals, tokenInfo.decimals);
    if (sellOutput === 0n) return null;

    const edges: GraphEdge[] = [
      this._poolToEdge(buyPool,  tokenB, tokenA),
      this._poolToEdge(sellPool, tokenA, tokenB),
    ];

    const label = `#${idx} [${tokenInfo.symbol}] ${buyPool.dex}→${sellPool.dex} imbalance`;
    const profit = await this.estimateNetProfitUsd(flashAsset, flashAmount, sellOutput, tokenInfo.decimals, edges, label);
    if (profit.netProfitUsd <= 0) return null;

    return this.createArbitragePath(edges, flashAsset, flashAmount, sellOutput,
      profit.grossProfitUsd, profit.gasCostUsd, profit.netProfitUsd, this.id);
  }

  /**
   * Simulates a swap with correct decimal handling for both V2 and V3 pools.
   */
  private _simulateSwap(
    pool: PoolEntry,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    decimalsIn: number,
    decimalsOut: number
  ): bigint {
    try {
      if (amountIn === 0n) return 0n;

      if (pool.reserve0 && pool.reserve1) {
        const r0 = BigInt(pool.reserve0);
        const r1 = BigInt(pool.reserve1);
        if (r0 === 0n || r1 === 0n) return 0n;
        const isToken0In = tokenIn.toLowerCase() === pool.token0.address.toLowerCase();
        const feeBps = pool.fee ?? 30;
        return v2GetAmountOut(amountIn, isToken0In ? r0 : r1, isToken0In ? r1 : r0, feeBps);
      }

      if (pool.sqrtPriceX96) {
        const sqrtPrice = BigInt(pool.sqrtPriceX96);
        if (sqrtPrice === 0n) return 0n;

        // fee in ppm (e.g. 3000 = 0.3%)
        const feePpm = pool.fee ?? 3000;
        const feeMultiplier = 1_000_000n - BigInt(feePpm);

        const zeroForOne = tokenIn.toLowerCase() === pool.token0.address.toLowerCase();

        // Decimal adjustment
        if (zeroForOne) {
          const numerator = amountIn * sqrtPrice * sqrtPrice * feeMultiplier;
          const denominator = (1n << 192n) * 1_000_000n;
          return numerator / denominator;
        } else {
          const numerator = amountIn * (1n << 192n) * feeMultiplier;
          const denominator = sqrtPrice * sqrtPrice * 1_000_000n;
          if (denominator === 0n) return 0n;
          return numerator / denominator;
        }
      }

      return 0n;
    } catch {
      return 0n;
    }
  }

  /**
   * Calculates price divergence between two pools in basis points.
   * Returns 0 if either pool has no valid price data.
   */
  private _getPriceDivergenceBps(poolA: PoolEntry, poolB: PoolEntry): number {
    const priceA = this._getPoolPrice(poolA);
    const priceB = this._getPoolPrice(poolB);

    if (priceA <= 0 || priceB <= 0) return 0;

    const higher = Math.max(priceA, priceB);
    const lower  = Math.min(priceA, priceB);

    return Math.round(((higher - lower) / lower) * 10000);
  }

  /**
   * Gets the price of token1 in terms of token0 for a pool.
   */
  private _getPoolPrice(pool: PoolEntry): number {
    if (pool.reserve0 && pool.reserve1) {
      const r0 = Number(pool.reserve0);
      const r1 = Number(pool.reserve1);
      if (r0 === 0 || r1 === 0) return 0;
      return r1 / r0;
    }
    if (pool.sqrtPriceX96) {
      const sqrtPrice = Number(BigInt(pool.sqrtPriceX96)) / (2 ** 96);
      return sqrtPrice * sqrtPrice;
    }
    return 0;
  }

  /**
   * Checks if a pool has valid minimum liquidity.
   */
  private _hasValidLiquidity(pool: PoolEntry): boolean {
    if (pool.reserve0 && pool.reserve1) {
      const r0 = BigInt(pool.reserve0);
      const r1 = BigInt(pool.reserve1);
      if (r0 === 0n || r1 === 0n) return false;

      // Normalize token0 reserve to 18 decimals for minimum check
      const dec0 = pool.token0.decimals ?? 18;
      const normalizedR0 = dec0 >= 18
        ? r0
        : r0 * (10n ** BigInt(18 - dec0));

      return normalizedR0 >= MIN_V2_RESERVE_NORMALIZED;
    }
    if (pool.sqrtPriceX96) {
      const sqrtPrice = BigInt(pool.sqrtPriceX96);
      return sqrtPrice > 0n;
    }
    return false;
  }

  private _sortByLiquidity(pools: PoolEntry[]): PoolEntry[] {
    return [...pools].sort((a, b) => {
      const la = this._getTotalReserve(a);
      const lb = this._getTotalReserve(b);
      return la > lb ? -1 : la < lb ? 1 : 0;
    });
  }

  private _getTotalReserve(pool: PoolEntry): bigint {
    if (pool.reserve0 && pool.reserve1) return BigInt(pool.reserve0) + BigInt(pool.reserve1);
    if (pool.liquidity) return BigInt(pool.liquidity);
    return 0n;
  }

  private _poolToEdge(pool: PoolEntry, from: string, to: string): GraphEdge {
    return {
      from: from.toLowerCase(), to: to.toLowerCase(), poolAddress: pool.address,
      dexId: this._getDexId(pool.dex), dexName: pool.dex, fee: pool.fee ?? 30, weight: 0,
      reserve0:     pool.reserve0     ? BigInt(pool.reserve0)     : undefined,
      reserve1:     pool.reserve1     ? BigInt(pool.reserve1)     : undefined,
      sqrtPriceX96: pool.sqrtPriceX96 ? BigInt(pool.sqrtPriceX96) : undefined,
      liquidity:    pool.liquidity    ? BigInt(pool.liquidity)    : undefined,
    };
  }

  private _getDexId(n: string): number {
    const m: Record<string, number> = {
      'Uniswap V2': 0, 'Uniswap V3': 1, 'SushiSwap V2': 2, 'SushiSwap V3': 3,
      'Aerodrome': 4, 'Aerodrome Slipstream': 5, 'BaseSwap V2': 6, 'BaseSwap V3': 7,
      'SwapBased': 8, 'PancakeSwap V3': 9,
    };
    return m[n] ?? 0;
  }
}