/**
 * @file SqrtPriceMath.ts
 * @description TypeScript implementation of SqrtPriceMath. Computes token amounts from
 *              liquidity and sqrt price changes. Implements getAmount0Delta and getAmount1Delta
 *              with full 256-bit precision using BigInt.
 */

import { mulDiv, mulDivRoundingUp } from '../../utils/bigIntMath';

const Q96 = 2n ** 96n;

/**
 * Gets the amount0 delta between two prices for a given liquidity.
 * @param sqrtRatioAX96 A sqrt price (Q64.96).
 * @param sqrtRatioBX96 Another sqrt price (Q64.96).
 * @param liquidity The amount of usable liquidity.
 * @param roundUp Whether to round the amount up or down.
 * @returns Amount of token0 required.
 */
export function getAmount0Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
  roundUp: boolean
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }

  if (sqrtRatioAX96 <= 0n) throw new Error('SqrtPriceMath: sqrtRatioAX96 must be positive');

  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtRatioBX96 - sqrtRatioAX96;

  if (roundUp) {
    return mulDivRoundingUp(
      mulDivRoundingUp(numerator1, numerator2, sqrtRatioBX96),
      1n,
      sqrtRatioAX96
    );
  } else {
    return mulDiv(numerator1, numerator2, sqrtRatioBX96) / sqrtRatioAX96;
  }
}

/**
 * Gets the amount1 delta between two prices for a given liquidity.
 * @param sqrtRatioAX96 A sqrt price (Q64.96).
 * @param sqrtRatioBX96 Another sqrt price (Q64.96).
 * @param liquidity The amount of usable liquidity.
 * @param roundUp Whether to round the amount up or down.
 * @returns Amount of token1 required.
 */
export function getAmount1Delta(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
  roundUp: boolean
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }

  const diff = sqrtRatioBX96 - sqrtRatioAX96;

  if (roundUp) {
    return mulDivRoundingUp(liquidity, diff, Q96);
  } else {
    return mulDiv(liquidity, diff, Q96);
  }
}

/**
 * Gets the next sqrt price given a delta of token0.
 * @param sqrtPX96 The starting price.
 * @param liquidity The amount of usable liquidity.
 * @param amount How much of token0 to add or remove.
 * @param add Whether to add or remove the amount.
 * @returns The price after the delta.
 */
export function getNextSqrtPriceFromAmount0RoundingUp(
  sqrtPX96: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean
): bigint {
  if (amount === 0n) return sqrtPX96;
  const numerator1 = liquidity << 96n;

  if (add) {
    const product = amount * sqrtPX96;
    if (product / amount === sqrtPX96) {
      const denominator = numerator1 + product;
      if (denominator >= numerator1) {
        return mulDivRoundingUp(numerator1, sqrtPX96, denominator);
      }
    }
    return mulDivRoundingUp(numerator1, 1n, numerator1 / sqrtPX96 + amount);
  } else {
    const product = amount * sqrtPX96;
    if (product / amount !== sqrtPX96) throw new Error('SqrtPriceMath: overflow');
    if (numerator1 <= product) throw new Error('SqrtPriceMath: underflow');
    const denominator = numerator1 - product;
    return mulDivRoundingUp(numerator1, sqrtPX96, denominator);
  }
}

/**
 * Gets the next sqrt price given a delta of token1.
 * @param sqrtPX96 The starting price.
 * @param liquidity The amount of usable liquidity.
 * @param amount How much of token1 to add or remove.
 * @param add Whether to add or remove the amount.
 * @returns The price after the delta.
 */
export function getNextSqrtPriceFromAmount1RoundingDown(
  sqrtPX96: bigint,
  liquidity: bigint,
  amount: bigint,
  add: boolean
): bigint {
  if (add) {
    const quotient = amount <= (2n ** 160n - 1n)
      ? (amount << 96n) / liquidity
      : mulDiv(amount, Q96, liquidity);
    return sqrtPX96 + quotient;
  } else {
    const quotient = amount <= (2n ** 160n - 1n)
      ? mulDivRoundingUp(amount, Q96, liquidity)
      : mulDivRoundingUp(amount, Q96, liquidity);
    if (sqrtPX96 <= quotient) throw new Error('SqrtPriceMath: price underflow');
    return sqrtPX96 - quotient;
  }
}

/**
 * Gets the next sqrt price given an input amount of token0 or token1.
 * @param sqrtPX96 The starting price.
 * @param liquidity The amount of usable liquidity.
 * @param amountIn How much of token0 or token1 is being swapped in.
 * @param zeroForOne Whether the amount in is token0 or token1.
 * @returns The price after swapping the amount in.
 */
export function getNextSqrtPriceFromInput(
  sqrtPX96: bigint,
  liquidity: bigint,
  amountIn: bigint,
  zeroForOne: boolean
): bigint {
  if (sqrtPX96 <= 0n) throw new Error('SqrtPriceMath: sqrtPX96 must be positive');
  if (liquidity <= 0n) throw new Error('SqrtPriceMath: liquidity must be positive');

  return zeroForOne
    ? getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountIn, true)
    : getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountIn, true);
}

/**
 * Gets the next sqrt price given an output amount of token0 or token1.
 * @param sqrtPX96 The starting price.
 * @param liquidity The amount of usable liquidity.
 * @param amountOut How much of token0 or token1 is being swapped out.
 * @param zeroForOne Whether the amount out is token0 or token1.
 * @returns The price after swapping the amount out.
 */
export function getNextSqrtPriceFromOutput(
  sqrtPX96: bigint,
  liquidity: bigint,
  amountOut: bigint,
  zeroForOne: boolean
): bigint {
  if (sqrtPX96 <= 0n) throw new Error('SqrtPriceMath: sqrtPX96 must be positive');
  if (liquidity <= 0n) throw new Error('SqrtPriceMath: liquidity must be positive');

  return zeroForOne
    ? getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountOut, false)
    : getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountOut, false);
}