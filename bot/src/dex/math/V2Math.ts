/**
 * @file V2Math.ts
 * @description Pure TypeScript implementation of Uniswap V2 AMM math using BigInt.
 *              Implements getAmountOut, getAmountIn, getSpotPrice. All intermediate
 *              calculations maintain full precision using BigInt arithmetic.
 */

/**
 * Calculates the output amount for a given input amount using the constant product formula.
 * @param amountIn The input amount.
 * @param reserveIn The reserve of the input token.
 * @param reserveOut The reserve of the output token.
 * @param feeBps The fee in basis points (e.g., 30 = 0.3%).
 * @returns The output amount.
 */
export function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number = 30
): bigint {
  if (amountIn <= 0n) return 0n;
  if (reserveIn <= 0n || reserveOut <= 0n) return 0n;

  const feeMultiplier = BigInt(10000 - feeBps);
  const amountInWithFee = amountIn * feeMultiplier;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 10000n + amountInWithFee;

  if (denominator === 0n) return 0n;

  return numerator / denominator;
}

/**
 * Calculates the required input amount for a desired output amount.
 * @param amountOut The desired output amount.
 * @param reserveIn The reserve of the input token.
 * @param reserveOut The reserve of the output token.
 * @param feeBps The fee in basis points (e.g., 30 = 0.3%).
 * @returns The required input amount.
 */
export function getAmountIn(
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number = 30
): bigint {
  if (amountOut <= 0n) return 0n;
  if (reserveIn <= 0n || reserveOut <= 0n) return 0n;
  if (amountOut >= reserveOut) return 0n; // Cannot extract more than reserve

  const feeMultiplier = BigInt(10000 - feeBps);
  const numerator = reserveIn * amountOut * 10000n;
  const denominator = (reserveOut - amountOut) * feeMultiplier;

  if (denominator === 0n) return 0n;

  return numerator / denominator + 1n; // Round up
}

/**
 * Calculates the spot price of token0 in terms of token1.
 * @param reserve0 The reserve of token0.
 * @param reserve1 The reserve of token1.
 * @param decimals0 The decimals of token0.
 * @param decimals1 The decimals of token1.
 * @returns The spot price as a BigInt with 18 decimal precision.
 */
export function getSpotPrice(
  reserve0: bigint,
  reserve1: bigint,
  decimals0: number,
  decimals1: number
): bigint {
  if (reserve0 === 0n || reserve1 === 0n) return 0n;

  const PRECISION = 10n ** 18n;

  // Normalize reserves to 18 decimals
  const normalizedReserve0 = decimals0 === 18
    ? reserve0
    : reserve0 * (10n ** BigInt(18 - decimals0));
  const normalizedReserve1 = decimals1 === 18
    ? reserve1
    : reserve1 * (10n ** BigInt(18 - decimals1));

  // price = reserve1 / reserve0 (with 18 decimal precision)
  return (normalizedReserve1 * PRECISION) / normalizedReserve0;
}

/**
 * Calculates the price impact of a trade.
 * @param amountIn The input amount.
 * @param reserveIn The reserve of the input token.
 * @param reserveOut The reserve of the output token.
 * @param feeBps The fee in basis points.
 * @returns The price impact in basis points.
 */
export function getPriceImpactBps(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: number = 30
): number {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0;

  // Spot price (no fee, no impact)
  const spotOutput = (amountIn * reserveOut) / reserveIn;
  if (spotOutput === 0n) return 0;

  // Actual output with fee and impact
  const actualOutput = getAmountOut(amountIn, reserveIn, reserveOut, feeBps);
  if (actualOutput === 0n) return 10000; // 100% impact

  // Impact = (spotOutput - actualOutput) / spotOutput * 10000
  const impact = ((spotOutput - actualOutput) * 10000n) / spotOutput;
  return Number(impact);
}

/**
 * Calculates the optimal input amount to maximize arbitrage profit between two pools.
 * Uses the formula derived from the constant product invariant.
 * @param reserveA_in Reserve of input token in pool A.
 * @param reserveA_out Reserve of output token in pool A.
 * @param reserveB_in Reserve of input token in pool B (selling pool).
 * @param reserveB_out Reserve of output token in pool B (selling pool).
 * @param feeA Fee in basis points for pool A.
 * @param feeB Fee in basis points for pool B.
 * @returns The optimal input amount, or 0n if no profitable trade exists.
 */
export function getOptimalAmountIn(
  reserveA_in: bigint,
  reserveA_out: bigint,
  reserveB_in: bigint,
  reserveB_out: bigint,
  feeA: number = 30,
  feeB: number = 30
): bigint {
  // Binary search for optimal amount
  let low = 1n;
  let high = reserveA_in / 2n; // Don't try more than half the reserve
  let bestAmount = 0n;
  let bestProfit = 0n;

  if (high <= low) return 0n;

  for (let i = 0; i < 128; i++) {
    if (low >= high) break;

    const mid = (low + high) / 2n;
    const midPlus = mid + 1n;

    const profitMid = _calculateProfit(mid, reserveA_in, reserveA_out, reserveB_in, reserveB_out, feeA, feeB);
    const profitMidPlus = _calculateProfit(midPlus, reserveA_in, reserveA_out, reserveB_in, reserveB_out, feeA, feeB);

    if (profitMid > bestProfit) {
      bestProfit = profitMid;
      bestAmount = mid;
    }

    if (profitMidPlus > profitMid) {
      low = mid + 1n;
    } else {
      high = mid;
    }
  }

  return bestProfit > 0n ? bestAmount : 0n;
}

/**
 * Internal helper to calculate profit for a given input amount across two pools.
 */
function _calculateProfit(
  amountIn: bigint,
  reserveA_in: bigint,
  reserveA_out: bigint,
  reserveB_in: bigint,
  reserveB_out: bigint,
  feeA: number,
  feeB: number
): bigint {
  // Buy on pool A
  const amountMid = getAmountOut(amountIn, reserveA_in, reserveA_out, feeA);
  if (amountMid === 0n) return 0n;

  // Sell on pool B (note: selling the output token, so reserveB_in is the output token's reserve in B)
  const amountOut = getAmountOut(amountMid, reserveB_out, reserveB_in, feeB);
  if (amountOut === 0n) return 0n;

  // Profit = amountOut - amountIn
  if (amountOut <= amountIn) return 0n;
  return amountOut - amountIn;
}