/**
 * @file TwoHopCrossDex.ts
 * @description Strategy 1: Simple Two-Hop Cross-DEX Arbitrage. Buy token A for token B on DEX X,
 *              sell token A for token B on DEX Y. Flash borrow token B. Evaluates all permutations
 *              of DEX pairs for each eligible pool-pair combination.
 *
 *              VERBOSE: Logs every candidate path scanned with full profit/loss details.
 */

import { BaseStrategy } from './BaseStrategy';
import { pairKey } from '../utils/addressUtils';
import { getAmountOut as v2GetAmountOut } from '../dex/math/V2Math';
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

    // For each pair with multiple DEX pools, check cross-DEX arbitrage
    for (const [pairK, poolGroup] of pairPools) {
      if (poolGroup.length < 2) continue;

      this.logger.debug(`Pair ${pairK}: ${poolGroup.length} pools across DEXes`, {
        dexes: poolGroup.map(p => `${p.dex}(${p.address.slice(0,8)})`).join(', '),
      });

      // Try all ordered pairs of pools (buy on i, sell on j)
      for (let i = 0; i < poolGroup.length; i++) {
        for (let j = 0; j < poolGroup.length; j++) {
          if (i === j) continue;
          if (poolGroup[i].dex === poolGroup[j].dex) continue;

          const buyPool  = poolGroup[i];
          const sellPool = poolGroup[j];

          // Determine flash asset (must be Aave-eligible)
          const flashAsset = buyPool.aaveAsset;
          if (!flashAsset) {
            this.logger.debug(`Skip: no Aave flash asset for pool ${buyPool.address.slice(0,10)} (${buyPool.dex})`);
            continue;
          }

          const isBuyToken0 = buyPool.token0.address.toLowerCase() === flashAsset.toLowerCase();
          const tokenA      = isBuyToken0 ? buyPool.token1.address : buyPool.token0.address;
          const tokenB      = flashAsset;
          const decimalsB   = isBuyToken0 ? buyPool.token0.decimals : buyPool.token1.decimals;

          // Estimate flash loan amount
          const flashAmount = this._estimateTradeSize(buyPool, flashAsset, decimalsB);
          if (flashAmount === 0n) {
            this.logger.debug(`Skip: zero flash amount for pool ${buyPool.address.slice(0,10)}`);
            continue;
          }

          // Simulate: buy tokenA with tokenB on buyPool
          const buyOutput = this._simulateSwap(buyPool, tokenB, tokenA, flashAmount);
          if (buyOutput === 0n) {
            this.logger.debug(`Skip: zero buy output on ${buyPool.dex} pool ${buyPool.address.slice(0,10)}`);
            continue;
          }

          // Simulate: sell tokenA for tokenB on sellPool
          const sellOutput = this._simulateSwap(sellPool, tokenA, tokenB, buyOutput);
          if (sellOutput === 0n) {
            this.logger.debug(`Skip: zero sell output on ${sellPool.dex} pool ${sellPool.address.slice(0,10)}`);
            continue;
          }

          candidateCount++;
          const label = `#${candidateCount} [${buyPool.token0.symbol}/${buyPool.token1.symbol}] ${buyPool.dex}→${sellPool.dex}`;

          const edges: GraphEdge[] = [
            this._poolToEdge(buyPool,  tokenB, tokenA),
            this._poolToEdge(sellPool, tokenA, tokenB),
          ];

          // Full profit calculation (logs candidate details)
          const profit = await this.estimateNetProfitUsd(
            flashAsset, flashAmount, sellOutput, decimalsB, edges, label
          );

          // Accept if net profit > 0 (threshold check is in simulation/execution layer)
          if (profit.netProfitUsd <= 0) continue;

          opportunities.push(this.createArbitragePath(
            edges, flashAsset, flashAmount, sellOutput,
            profit.grossProfitUsd, profit.gasCostUsd, profit.netProfitUsd,
            this.id
          ));
        }
      }
    }

    // Sort by net profit descending
    opportunities.sort((a, b) => b.estimatedNetProfitUsd - a.estimatedNetProfitUsd);

    this.logger.info('Two-hop cross-DEX scan complete', {
      pairsWithMultiplePools: [...pairPools.values()].filter(g => g.length >= 2).length,
      candidatesEvaluated: candidateCount,
      opportunities: opportunities.length,
    });
    return opportunities;
  }

  private _simulateSwap(pool: PoolEntry, tokenIn: string, tokenOut: string, amountIn: bigint): bigint {
    try {
      if (pool.reserve0 && pool.reserve1) {
        const r0 = BigInt(pool.reserve0);
        const r1 = BigInt(pool.reserve1);
        if (r0 === 0n || r1 === 0n) return 0n;

        const isToken0In = tokenIn.toLowerCase() === pool.token0.address.toLowerCase();
        const reserveIn  = isToken0In ? r0 : r1;
        const reserveOut = isToken0In ? r1 : r0;
        const fee        = pool.fee ?? 30;

        return v2GetAmountOut(amountIn, reserveIn, reserveOut, fee);
      }

      if (pool.sqrtPriceX96) {
        const sqrtPrice = BigInt(pool.sqrtPriceX96);
        if (sqrtPrice === 0n) return 0n;
        const fee = pool.fee ?? 3000;
        const zeroForOne = tokenIn.toLowerCase() === pool.token0.address.toLowerCase();
        const amountInAfterFee = (amountIn * BigInt(1000000 - fee)) / 1000000n;

        if (zeroForOne) {
          return (amountInAfterFee * sqrtPrice * sqrtPrice) >> 192n;
        } else {
          const priceNum = sqrtPrice * sqrtPrice;
          if (priceNum === 0n) return 0n;
          return (amountInAfterFee << 192n) / priceNum;
        }
      }

      return 0n;
    } catch {
      return 0n;
    }
  }

  private _estimateTradeSize(pool: PoolEntry, flashAsset: string, decimals: number): bigint {
    if (pool.reserve0 && pool.reserve1) {
      const isToken0 = pool.token0.address.toLowerCase() === flashAsset.toLowerCase();
      const reserve  = BigInt(isToken0 ? pool.reserve0 : pool.reserve1);
      if (reserve === 0n) return 0n;
      return reserve / 50n; // 2% of reserve
    }
    if (pool.sqrtPriceX96 && pool.liquidity) {
      const liq = BigInt(pool.liquidity);
      if (liq === 0n) return 10n ** BigInt(decimals) * 1000n;
      return liq / 1000n; // 0.1% of liquidity
    }
    // Default: $1000 equivalent
    return 10n ** BigInt(decimals) * 1000n;
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
      reserve0:     pool.reserve0  ? BigInt(pool.reserve0)  : undefined,
      reserve1:     pool.reserve1  ? BigInt(pool.reserve1)  : undefined,
      sqrtPriceX96: pool.sqrtPriceX96 ? BigInt(pool.sqrtPriceX96) : undefined,
      liquidity:    pool.liquidity ? BigInt(pool.liquidity) : undefined,
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