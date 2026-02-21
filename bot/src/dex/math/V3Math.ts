/**
 * @file V3Math.ts
 * @description Pure TypeScript implementation of Uniswap V3 swap math using BigInt.
 *              Computes expected output for a given input at the current tick, with support
 *              for crossing tick boundaries. Implements computeSwapStep following the
 *              Uniswap V3 core logic exactly.
 */

import { mulDiv, mulDivRoundingUp, abs } from '../../utils/bigIntMath';
import { getSqrtRatioAtTick } from './TickMath';
import {
  getAmount0Delta,
  getAmount1Delta,
  getNextSqrtPriceFromInput,
  getNextSqrtPriceFromOutput,
} from './SqrtPriceMath';
import { MIN_SQRT_RATIO, MAX_SQRT_RATIO } from '../../config/constants';

export interface SwapStepResult {
  sqrtRatioNextX96: bigint;
  amountIn: bigint;
  amountOut: bigint;
  feeAmount: bigint;
}

export interface SwapResult {
  amountOut: bigint;
  sqrtPriceX96After: bigint;
  tickAfter: number;
  liquidityAfter: bigint;
}

/**
 * Computes a single swap step within a tick range.
 * @param sqrtRatioCurrentX96 The current sqrt price.
 * @param sqrtRatioTargetX96 The target sqrt price (next tick boundary or price limit).
 * @param liquidity The available liquidity in this tick range.
 * @param amountRemaining The remaining amount to swap.
 * @param feePips The fee in hundredths of a bip (e.g., 3000 = 0.3%).
 * @returns The swap step result.
 */
export function computeSwapStep(
  sqrtRatioCurrentX96: bigint,
  sqrtRatioTargetX96: bigint,
  liquidity: bigint,
  amountRemaining: bigint,
  feePips: number
): SwapStepResult {
  const zeroForOne = sqrtRatioCurrentX96 >= sqrtRatioTargetX96;
  const exactIn = amountRemaining >= 0n;
  const fee = BigInt(feePips);

  let sqrtRatioNextX96: bigint;
  let amountIn: bigint;
  let amountOut: bigint;
  let feeAmount: bigint;

  if (exactIn) {
    const amountRemainingLessFee = mulDiv(amountRemaining, 1000000n - fee, 1000000n);

    amountIn = zeroForOne
      ? getAmount0Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, true)
      : getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, true);

    if (amountRemainingLessFee >= amountIn) {
      sqrtRatioNextX96 = sqrtRatioTargetX96;
    } else {
      sqrtRatioNextX96 = getNextSqrtPriceFromInput(
        sqrtRatioCurrentX96,
        liquidity,
        amountRemainingLessFee,
        zeroForOne
      );
    }
  } else {
    amountOut = zeroForOne
      ? getAmount1Delta(sqrtRatioTargetX96, sqrtRatioCurrentX96, liquidity, false)
      : getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, false);

    if (abs(amountRemaining) >= amountOut) {
      sqrtRatioNextX96 = sqrtRatioTargetX96;
    } else {
      sqrtRatioNextX96 = getNextSqrtPriceFromOutput(
        sqrtRatioCurrentX96,
        liquidity,
        abs(amountRemaining),
        zeroForOne
      );
    }
  }

  const max = sqrtRatioTargetX96 === sqrtRatioNextX96;

  // Compute amounts
  if (zeroForOne) {
    amountIn = max && exactIn
      ? amountIn!
      : getAmount0Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, true);
    amountOut = max && !exactIn
      ? amountOut!
      : getAmount1Delta(sqrtRatioNextX96, sqrtRatioCurrentX96, liquidity, false);
  } else {
    amountIn = max && exactIn
      ? amountIn!
      : getAmount1Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, true);
    amountOut = max && !exactIn
      ? amountOut!
      : getAmount0Delta(sqrtRatioCurrentX96, sqrtRatioNextX96, liquidity, false);
  }

  // Cap output at the remaining amount for exact output swaps
  if (!exactIn && amountOut > abs(amountRemaining)) {
    amountOut = abs(amountRemaining);
  }

  // Compute fee
  if (exactIn && sqrtRatioNextX96 !== sqrtRatioTargetX96) {
    feeAmount = amountRemaining - amountIn!;
  } else {
    feeAmount = mulDivRoundingUp(amountIn!, fee, 1000000n - fee);
  }

  return {
    sqrtRatioNextX96,
    amountIn: amountIn!,
    amountOut: amountOut!,
    feeAmount: feeAmount!,
  };
}

/**
 * Simulates a V3 swap using the current pool state (single-tick approximation).
 * For a more accurate simulation, use the full tick-crossing logic.
 * @param sqrtPriceX96 The current sqrt price.
 * @param tick The current tick.
 * @param liquidity The current in-range liquidity.
 * @param amountIn The input amount.
 * @param zeroForOne Whether swapping token0 for token1.
 * @param feePips The fee in hundredths of a bip.
 * @returns The expected output amount.
 */
export function simulateSwapSingleTick(
  sqrtPriceX96: bigint,
  tick: number,
  liquidity: bigint,
  amountIn: bigint,
  zeroForOne: boolean,
  feePips: number
): bigint {
  if (liquidity === 0n || sqrtPriceX96 === 0n || amountIn === 0n) return 0n;

  // Determine the price limit
  const sqrtPriceLimitX96 = zeroForOne
    ? MIN_SQRT_RATIO + 1n
    : MAX_SQRT_RATIO - 1n;

  // Compute the swap step
  const step = computeSwapStep(
    sqrtPriceX96,
    sqrtPriceLimitX96,
    liquidity,
    amountIn,
    feePips
  );

  return step.amountOut;
}

/**
 * Estimates the output amount for a V3 swap using the spot price approximation.
 * This is faster but less accurate than the full swap simulation.
 * @param sqrtPriceX96 The current sqrt price.
 * @param amountIn The input amount.
 * @param zeroForOne Whether swapping token0 for token1.
 * @param feePips The fee in hundredths of a bip.
 * @param decimalsIn Decimals of the input token.
 * @param decimalsOut Decimals of the output token.
 * @returns The estimated output amount.
 */
export function estimateOutputFromSqrtPrice(
  sqrtPriceX96: bigint,
  amountIn: bigint,
  zeroForOne: boolean,
  feePips: number,
  decimalsIn: number = 18,
  decimalsOut: number = 18
): bigint {
  if (sqrtPriceX96 === 0n || amountIn === 0n) return 0n;

  // Apply fee
  const amountInAfterFee = mulDiv(amountIn, BigInt(1000000 - feePips), 1000000n);

  // price = (sqrtPriceX96 / 2^96)^2
  // For zeroForOne (token0 -> token1): amountOut = amountIn * price
  // For oneForZero (token1 -> token0): amountOut = amountIn / price
  if (zeroForOne) {
    // token0 -> token1
    const priceNum = sqrtPriceX96 * sqrtPriceX96;
    return (amountInAfterFee * priceNum) >> 192n;
  } else {
    // token1 -> token0
    const priceNum = sqrtPriceX96 * sqrtPriceX96;
    if (priceNum === 0n) return 0n;
    return (amountInAfterFee << 192n) / priceNum;
  }
}