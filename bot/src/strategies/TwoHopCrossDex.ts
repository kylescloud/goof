/**
 * @file TwoHopCrossDex.ts
 * @description Strategy 1: Simple Two-Hop Cross-DEX Arbitrage. Buy token A for token B on DEX X,
 *              sell token A for token B on DEX Y. Flash borrow token B.
 *
 *              FIXES:
 *              - Uses safeFlashAmountFromPool with hard caps
 *              - Validates minimum pool liquidity before scanning
 *              - Correct V3 price math with decimal adjustment
 *              - Skips pools with zero/invalid reserves
 */

import { BaseStrategy } from './BaseStrategy';
import { pairKey } from '../utils/addressUtils';
import { getAmountOut as v2GetAmountOut } from '../dex/math/V2Math';
import { TOKEN_BY_ADDRESS } from '../config/addresses';
import { MIN_V2_RESERVE_NORMALIZED } from '../config/constants';
import { safeFlashAmountFromPool } from './flashAmountUtils';
import type { ArbitragePath, GraphEdge } from '../graph/types';
import type { PoolEntry } from '../discovery/types';

export class TwoHopCrossDex extends BaseStrategy {
  readonly name = 'Two-Hop Cross-DEX';
  readonly id = 'two-hop-cross-dex';

  async findOpportunities(): Promise<ArbitragePath[]> {
    const opportunities: ArbitragePath[] = [];
    const pools = this.registry.pools;
    const poolList = Object.values(pools);

    this.logger.info(`Scanning ${poolList.length} pools for two-hop cross-DEX opportunities`);

    // Group pools by token pair
    const pairPools = new Map<string, PoolEntry[]>();
    for (const pool of poolList) {
      const key = pairKey(pool.token0.address, pool.token1.address);
      if (!pairPools.has(key)) pairPools.set(key, []);
      pairPools.get(key)!.push(pool);
    }

    let candidateCount = 0;

    for (const [pairK, poolGroup] of pairPools) {
      if (poolGroup.length < 2) continue;

      this.logger.debug(`Pair ${pairK}: ${poolGroup.length} pools across DEXes`, {
        dexes: poolGroup.map(p => `${p.dex}(${p.address.slice(0, 8)})`).join(', '),
      });

      for (let i = 0; i < poolGroup.length; i++) {
        for (let j = 0; j < poolGroup.length; j++) {
          if (i === j) continue;
          if (poolGroup[i].dex === poolGroup[j].dex) continue;

          const buyPool  = poolGroup[i];
          const sellPool = poolGroup[j];

          // Skip pools with insufficient liquidity
          if (!this._hasValidLiquidity(buyPool)) continue;
          if (!this._hasValidLiquidity(sellPool)) continue;

          const flashAsset = buyPool.aaveAsset;
          if (!flashAsset) continue;

          const isBuyToken0 = buyPool.token0.address.toLowerCase() === flashAsset.toLowerCase();
          const tokenA      = isBuyToken0 ? buyPool.token1.address : buyPool.token0.address;
          const tokenB      = flashAsset;
          const decimalsB   = isBuyToken0 ? (buyPool.token0.decimals ?? 18) : (buyPool.token1.decimals ?? 18);

          const tokenAInfo = TOKEN_BY_ADDRESS[tokenA.toLowerCase()];
          const decimalsA  = tokenAInfo?.decimals ?? 18;

          const flashAmount = safeFlashAmountFromPool(buyPool, flashAsset, decimalsB);
          if (flashAmount === 0n) continue;

          const buyOutput = this._simulateSwap(buyPool, tokenB, tokenA, flashAmount, decimalsB, decimalsA);
          if (buyOutput === 0n) continue;

          const sellOutput = this._simulateSwap(sellPool, tokenA, tokenB, buyOutput, decimalsA, decimalsB);
          if (sellOutput === 0n) continue;

          candidateCount++;
          const label = `#${candidateCount} [${buyPool.token0.symbol}/${buyPool.token1.symbol}] ${buyPool.dex}→${sellPool.dex}`;

          const edges: GraphEdge[] = [
            this._poolToEdge(buyPool,  tokenB, tokenA),
            this._poolToEdge(sellPool, tokenA, tokenB),
          ];

          const profit = await this.estimateNetProfitUsd(
            flashAsset, flashAmount, sellOutput, decimalsB, edges, label
          );

          if (profit.netProfitUsd <= 0) continue;

          opportunities.push(this.createArbitragePath(
            edges, flashAsset, flashAmount, sellOutput,
            profit.grossProfitUsd, profit.gasCostUsd, profit.netProfitUsd,
            this.id
          ));
        }
      }
    }

    opportunities.sort((a, b) => b.estimatedNetProfitUsd - a.estimatedNetProfitUsd);

    this.logger.info('Two-hop cross-DEX scan complete', {
      pairsWithMultiplePools: [...pairPools.values()].filter(g => g.length >= 2).length,
      candidatesEvaluated: candidateCount,
      opportunities: opportunities.length,
    });
    return opportunities;
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
        const reserveIn  = isToken0In ? r0 : r1;
        const reserveOut = isToken0In ? r1 : r0;
        const feeBps     = pool.fee ?? 30;

        return v2GetAmountOut(amountIn, reserveIn, reserveOut, feeBps);
      }

      if (pool.sqrtPriceX96) {
        const sqrtPrice = BigInt(pool.sqrtPriceX96);
        if (sqrtPrice === 0n) return 0n;

        const feePpm = pool.fee ?? 3000;
        const feeMultiplier = 1_000_000n - BigInt(feePpm);
        const zeroForOne = tokenIn.toLowerCase() === pool.token0.address.toLowerCase();

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

  private _hasValidLiquidity(pool: PoolEntry): boolean {
    if (pool.reserve0 && pool.reserve1) {
      const r0 = BigInt(pool.reserve0);
      const r1 = BigInt(pool.reserve1);
      if (r0 === 0n || r1 === 0n) return false;
      const dec0 = pool.token0.decimals ?? 18;
      const normalizedR0 = dec0 >= 18 ? r0 : r0 * (10n ** BigInt(18 - dec0));
      return normalizedR0 >= MIN_V2_RESERVE_NORMALIZED;
    }
    if (pool.sqrtPriceX96) {
      return BigInt(pool.sqrtPriceX96) > 0n;
    }
    return false;
  }

  private _poolToEdge(pool: PoolEntry, from: string, to: string): GraphEdge {
    return {
      from:         from.toLowerCase(),
      to:           to.toLowerCase(),
      poolAddress:  pool.address,
      dexId:        this._getDexId(pool.dex),
      dexName:      pool.dex,
      fee:          pool.fee ?? 30,
      weight:       0,
      reserve0:     pool.reserve0     ? BigInt(pool.reserve0)     : undefined,
      reserve1:     pool.reserve1     ? BigInt(pool.reserve1)     : undefined,
      sqrtPriceX96: pool.sqrtPriceX96 ? BigInt(pool.sqrtPriceX96) : undefined,
      liquidity:    pool.liquidity    ? BigInt(pool.liquidity)    : undefined,
      tick:         pool.tick ?? undefined,
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