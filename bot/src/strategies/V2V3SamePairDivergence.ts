/**
 * @file V2V3SamePairDivergence.ts
 * @description Strategy 3: V2/V3 Same-Pair Price Divergence. Detects when the same token pair
 *              has a price discrepancy between a V2 pool and a V3 pool.
 *
 *              FIXES:
 *              - Uses safeFlashAmountFromPool with hard caps
 *              - Validates minimum pool liquidity before scanning
 *              - Correct V3 price math with decimal adjustment
 *              - Caps divergence at MAX_DIVERGENCE_BPS to skip broken pools
 */

import { BaseStrategy } from './BaseStrategy';
import { ProtocolVersion, MAX_DIVERGENCE_BPS, MIN_V2_RESERVE_NORMALIZED } from '../config/constants';
import { pairKey } from '../utils/addressUtils';
import { getAmountOut as v2GetAmountOut } from '../dex/math/V2Math';
import { TOKEN_BY_ADDRESS } from '../config/addresses';
import { safeFlashAmountFromPool } from './flashAmountUtils';
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

    const mixedPairs = [...pairPools.values()].filter(g => g.v2.length > 0 && g.v3.length > 0);
    this.logger.info(`Scanning ${mixedPairs.length} pairs with both V2+V3 pools for divergence`);

    let candidateCount = 0;

    for (const [, group] of pairPools) {
      if (group.v2.length === 0 || group.v3.length === 0) continue;

      for (const v2Pool of group.v2) {
        if (!this._hasValidLiquidity(v2Pool)) continue;

        for (const v3Pool of group.v3) {
          if (!this._hasValidLiquidity(v3Pool)) continue;

          candidateCount++;
          const result = await this._checkDivergence(v2Pool, v3Pool, candidateCount);
          if (result) opportunities.push(result);

          candidateCount++;
          const reverseResult = await this._checkDivergence(v3Pool, v2Pool, candidateCount);
          if (reverseResult) opportunities.push(reverseResult);
        }
      }
    }

    opportunities.sort((a, b) => b.estimatedNetProfitUsd - a.estimatedNetProfitUsd);
    this.logger.info('V2/V3 divergence scan complete', {
      candidatesEvaluated: candidateCount,
      opportunities: opportunities.length,
    });
    return opportunities;
  }

  private async _checkDivergence(buyPool: PoolEntry, sellPool: PoolEntry, idx: number): Promise<ArbitragePath | null> {
    const flashAsset = buyPool.aaveAsset;
    if (!flashAsset) return null;

    const tokenInfo = TOKEN_BY_ADDRESS[flashAsset.toLowerCase()];
    if (!tokenInfo) return null;

    const isBuyToken0 = buyPool.token0.address.toLowerCase() === flashAsset.toLowerCase();
    const tokenA = isBuyToken0 ? buyPool.token1.address : buyPool.token0.address;
    const tokenB = flashAsset;

    const tokenAInfo = TOKEN_BY_ADDRESS[tokenA.toLowerCase()];
    const tokenADecimals = tokenAInfo?.decimals ?? 18;

    // Calculate divergence using a test amount
    const divergenceBps = this._calculateDivergenceBps(
      buyPool, sellPool, tokenB, tokenA, tokenInfo.decimals, tokenADecimals
    );

    this.logger.debug(`V2/V3 divergence check #${idx}`, {
      buyPool:  `${buyPool.dex}(${buyPool.address.slice(0, 10)})`,
      sellPool: `${sellPool.dex}(${sellPool.address.slice(0, 10)})`,
      pair: `${buyPool.token0.symbol}/${buyPool.token1.symbol}`,
      divergenceBps,
      threshold: this.config.v2v3DivergenceThresholdBps,
    });

    // Skip if below threshold or above max (broken pool)
    if (divergenceBps < this.config.v2v3DivergenceThresholdBps) return null;
    if (divergenceBps > MAX_DIVERGENCE_BPS) {
      this.logger.debug('Skipping: divergence too large (broken pool)', { divergenceBps });
      return null;
    }

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

    const label = `#${idx} [${tokenInfo.symbol}] ${buyPool.dex}→${sellPool.dex} divergence=${divergenceBps}bps`;

    const profit = await this.estimateNetProfitUsd(
      flashAsset, flashAmount, sellOutput, tokenInfo.decimals, edges, label
    );

    if (profit.netProfitUsd <= 0) return null;

    return this.createArbitragePath(
      edges, flashAsset, flashAmount, sellOutput,
      profit.grossProfitUsd, profit.gasCostUsd, profit.netProfitUsd,
      this.id
    );
  }

  private _calculateDivergenceBps(
    pool1: PoolEntry,
    pool2: PoolEntry,
    tokenIn: string,
    tokenOut: string,
    decimalsIn: number,
    decimalsOut: number
  ): number {
    // Use a small test amount: 1 unit of tokenIn
    const testAmount = 10n ** BigInt(decimalsIn);
    const out1 = this._simulateSwap(pool1, tokenIn, tokenOut, testAmount, decimalsIn, decimalsOut);
    const out2 = this._simulateSwap(pool2, tokenIn, tokenOut, testAmount, decimalsIn, decimalsOut);
    if (out1 === 0n || out2 === 0n) return 0;
    const diff = out1 > out2 ? out1 - out2 : out2 - out1;
    const avg  = (out1 + out2) / 2n;
    if (avg === 0n) return 0;
    return Number((diff * 10000n) / avg);
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
      from: from.toLowerCase(), to: to.toLowerCase(), poolAddress: pool.address,
      dexId: this._getDexId(pool.dex), dexName: pool.dex, fee: pool.fee ?? 30, weight: 0,
      reserve0:     pool.reserve0     ? BigInt(pool.reserve0)     : undefined,
      reserve1:     pool.reserve1     ? BigInt(pool.reserve1)     : undefined,
      sqrtPriceX96: pool.sqrtPriceX96 ? BigInt(pool.sqrtPriceX96) : undefined,
      liquidity:    pool.liquidity    ? BigInt(pool.liquidity)    : undefined,
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