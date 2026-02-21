/**
 * @file StableMath.ts
 * @description TypeScript implementation of the StableSwap (Curve-style) invariant math
 *              used by Aerodrome stable pools. Implements the D invariant calculation via
 *              Newton's method, and getAmountOut against the stable curve.
 *              Handles token decimal normalization.
 */

const PRECISION = 10n ** 18n;

/**
 * Computes the StableSwap invariant D using Newton's method.
 * D satisfies: A * n^n * sum(x_i) + D = A * D * n^n + D^(n+1) / (n^n * prod(x_i))
 * For n=2: A * 4 * (x0 + x1) + D = A * D * 4 + D^3 / (4 * x0 * x1)
 *
 * @param x0 Normalized reserve of token0 (18 decimals).
 * @param x1 Normalized reserve of token1 (18 decimals).
 * @returns The invariant D.
 */
export function computeD(x0: bigint, x1: bigint): bigint {
  // Aerodrome stable pools use the x^3*y + y^3*x >= k invariant
  // which is different from Curve's StableSwap
  // For Aerodrome: k = x^3*y + y^3*x
  return _computeK(x0, x1);
}

/**
 * Computes k = x^3*y + y^3*x for Aerodrome stable pools.
 * @param x Normalized reserve of token0.
 * @param y Normalized reserve of token1.
 * @returns The invariant k.
 */
function _computeK(x: bigint, y: bigint): bigint {
  const _a = (x * y) / PRECISION;
  const _b = (x * x + y * y) / PRECISION;
  return (_a * _b) / PRECISION;
}

/**
 * Computes the output amount for a stable swap using the Aerodrome invariant.
 * Uses Newton's method to find y such that k(x_new, y_new) = k(x_old, y_old).
 *
 * @param amountIn The input amount (in token's native decimals).
 * @param reserveIn The reserve of the input token (native decimals).
 * @param reserveOut The reserve of the output token (native decimals).
 * @param decimalsIn The decimals of the input token.
 * @param decimalsOut The decimals of the output token.
 * @param fee The fee in basis points (default 1 = 0.01% for stable pools).
 * @returns The output amount in the output token's native decimals.
 */
export function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  decimalsIn: number,
  decimalsOut: number,
  fee: number = 1
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;

  // Apply fee
  const feeBps = BigInt(fee);
  const amountInAfterFee = amountIn - (amountIn * feeBps) / 10000n;

  // Normalize to 18 decimals
  const precisionIn = 10n ** BigInt(decimalsIn);
  const precisionOut = 10n ** BigInt(decimalsOut);

  const x0 = (reserveIn * PRECISION) / precisionIn;
  const y0 = (reserveOut * PRECISION) / precisionOut;

  // New x after adding input
  const x1 = x0 + (amountInAfterFee * PRECISION) / precisionIn;

  // Compute current k
  const k = _computeK(x0, y0);

  // Find new y using Newton's method such that k(x1, y1) = k
  const y1 = _getY(x1, k, y0);

  if (y0 <= y1) return 0n;

  // Convert back to output token decimals
  const dy = ((y0 - y1) * precisionOut) / PRECISION;

  return dy;
}

/**
 * Uses Newton's method to find y such that k(x, y) = k_target.
 * @param x The new x value (normalized to 18 decimals).
 * @param k The target invariant.
 * @param y0 Initial guess for y.
 * @returns The new y value.
 */
function _getY(x: bigint, k: bigint, y0: bigint): bigint {
  let y = y0;

  for (let i = 0; i < 255; i++) {
    const kCurrent = _computeK(x, y);
    const dy = _getDy(x, y, k, kCurrent);

    if (dy === 0n) break;

    if (kCurrent > k) {
      y = y - dy;
    } else {
      y = y + dy;
    }
  }

  return y;
}

/**
 * Computes the Newton step for finding y.
 * f(y) = k(x, y) - k_target
 * f'(y) = dk/dy = x^3 + 3*x*y^2 (derivative of x^3*y + y^3*x with respect to y)
 */
function _getDy(x: bigint, y: bigint, kTarget: bigint, kCurrent: bigint): bigint {
  // f'(y) = x^3/1e18/1e18 + 3*x*y^2/1e18/1e18
  const x3 = (x * x * x) / PRECISION / PRECISION;
  const xy2 = (3n * x * y * y) / PRECISION / PRECISION;
  const derivative = x3 + xy2;

  if (derivative === 0n) return 0n;

  const diff = kCurrent > kTarget ? kCurrent - kTarget : kTarget - kCurrent;

  // Newton step: dy = f(y) / f'(y)
  const dy = (diff * PRECISION) / derivative;

  // Clamp to prevent overshooting
  if (dy > y / 2n) return y / 2n;

  return dy > 0n ? dy : 1n;
}

/**
 * Computes the spot price for a stable pair.
 * @param reserve0 Reserve of token0 (native decimals).
 * @param reserve1 Reserve of token1 (native decimals).
 * @param decimals0 Decimals of token0.
 * @param decimals1 Decimals of token1.
 * @returns The spot price of token0 in terms of token1 (18 decimal precision).
 */
export function getStableSpotPrice(
  reserve0: bigint,
  reserve1: bigint,
  decimals0: number,
  decimals1: number
): bigint {
  if (reserve0 === 0n || reserve1 === 0n) return 0n;

  // For stable pools near parity, price ≈ 1
  // More precisely: dy/dx at the current point
  const precision0 = 10n ** BigInt(decimals0);
  const precision1 = 10n ** BigInt(decimals1);

  const x = (reserve0 * PRECISION) / precision0;
  const y = (reserve1 * PRECISION) / precision1;

  // Derivative: dy/dx = -(3*x^2*y + y^3) / (x^3 + 3*x*y^2)
  const numerator = 3n * x * x * y / PRECISION / PRECISION + y * y * y / PRECISION / PRECISION;
  const denominator = x * x * x / PRECISION / PRECISION + 3n * x * y * y / PRECISION / PRECISION;

  if (denominator === 0n) return PRECISION; // Default to 1:1

  return (numerator * PRECISION) / denominator;
}

/**
 * Checks if a stable pair is within acceptable peg range.
 * @param reserve0 Reserve of token0.
 * @param reserve1 Reserve of token1.
 * @param decimals0 Decimals of token0.
 * @param decimals1 Decimals of token1.
 * @param maxDeviationBps Maximum acceptable deviation in basis points.
 * @returns True if the pair is within peg range.
 */
export function isWithinPeg(
  reserve0: bigint,
  reserve1: bigint,
  decimals0: number,
  decimals1: number,
  maxDeviationBps: number
): boolean {
  const price = getStableSpotPrice(reserve0, reserve1, decimals0, decimals1);
  const deviation = price > PRECISION ? price - PRECISION : PRECISION - price;
  const maxDeviation = (PRECISION * BigInt(maxDeviationBps)) / 10000n;
  return deviation <= maxDeviation;
}