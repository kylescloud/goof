/**
 * @file TickMath.ts
 * @description TypeScript port of the Uniswap V3 TickMath library.
 *              Implements getSqrtRatioAtTick and getTickAtSqrtRatio using the same
 *              magic number constants as the Solidity original.
 */

import { MIN_TICK, MAX_TICK, MIN_SQRT_RATIO, MAX_SQRT_RATIO } from '../../config/constants';

/**
 * Computes sqrt(1.0001^tick) * 2^96 for a given tick.
 * @param tick The tick value.
 * @returns The sqrt price as a Q64.96 BigInt.
 * @throws If tick is out of bounds.
 */
export function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = Math.abs(tick);
  if (absTick > MAX_TICK) throw new Error(`TickMath: tick ${tick} out of bounds`);

  let ratio: bigint = (absTick & 0x1) !== 0
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;

  if ((absTick & 0x2) !== 0) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4) !== 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8) !== 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10) !== 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20) !== 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40) !== 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80) !== 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100) !== 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200) !== 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400) !== 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800) !== 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000) !== 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000) !== 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000) !== 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000) !== 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000) !== 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000) !== 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000) !== 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000) !== 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) {
    ratio = (2n ** 256n - 1n) / ratio;
  }

  // Divide by 1<<32 rounding up to go from Q128.128 to Q128.96
  const remainder = ratio % (1n << 32n);
  return (ratio >> 32n) + (remainder === 0n ? 0n : 1n);
}

/**
 * Computes the greatest tick value such that getSqrtRatioAtTick(tick) <= sqrtPriceX96.
 * @param sqrtPriceX96 The sqrt price as a Q64.96 BigInt.
 * @returns The tick value.
 * @throws If sqrtPriceX96 is out of bounds.
 */
export function getTickAtSqrtRatio(sqrtPriceX96: bigint): number {
  if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) {
    throw new Error(`TickMath: sqrtPriceX96 ${sqrtPriceX96} out of bounds`);
  }

  let ratio = sqrtPriceX96 << 32n;
  let r = ratio;
  let msb = 0n;

  // Find most significant bit
  let f = r > 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFn ? 1n << 7n : 0n;
  msb = msb | f;
  r = r >> f;

  f = r > 0xFFFFFFFFFFFFFFFFn ? 1n << 6n : 0n;
  msb = msb | f;
  r = r >> f;

  f = r > 0xFFFFFFFFn ? 1n << 5n : 0n;
  msb = msb | f;
  r = r >> f;

  f = r > 0xFFFFn ? 1n << 4n : 0n;
  msb = msb | f;
  r = r >> f;

  f = r > 0xFFn ? 1n << 3n : 0n;
  msb = msb | f;
  r = r >> f;

  f = r > 0xFn ? 1n << 2n : 0n;
  msb = msb | f;
  r = r >> f;

  f = r > 0x3n ? 1n << 1n : 0n;
  msb = msb | f;
  r = r >> f;

  f = r > 0x1n ? 1n : 0n;
  msb = msb | f;

  if (msb >= 128n) {
    r = ratio >> (msb - 127n);
  } else {
    r = ratio << (127n - msb);
  }

  let log_2 = (msb - 128n) << 64n;

  for (let i = 63n; i >= 51n; i--) {
    r = (r * r) >> 127n;
    const f2 = r >> 128n;
    log_2 = log_2 | (f2 << i);
    r = r >> f2;
  }

  const log_sqrt10001 = log_2 * 255738958999603826347141n;

  const tickLow = Number((log_sqrt10001 - 3402992956809132418596140100660247210n) >> 128n);
  const tickHi = Number((log_sqrt10001 + 291339464771989622907027621153398088495n) >> 128n);

  if (tickLow === tickHi) {
    return tickLow;
  }

  return getSqrtRatioAtTick(tickHi) <= sqrtPriceX96 ? tickHi : tickLow;
}

/**
 * Returns the minimum sqrt ratio for a given tick spacing.
 */
export function getMinTick(tickSpacing: number): number {
  return Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
}

/**
 * Returns the maximum sqrt ratio for a given tick spacing.
 */
export function getMaxTick(tickSpacing: number): number {
  return Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
}