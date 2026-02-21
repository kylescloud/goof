/**
 * @file bigIntMath.ts
 * @description BigInt arithmetic utilities: mulDiv, abs, min, max, sqrt, and decimal conversion.
 *              All intermediate calculations maintain full precision using BigInt arithmetic.
 */

/**
 * Computes (a * b) / denominator with full precision, rounding down.
 * @throws If denominator is zero.
 */
export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('mulDiv: division by zero');
  return (a * b) / denominator;
}

/**
 * Computes (a * b) / denominator with full precision, rounding up.
 * @throws If denominator is zero.
 */
export function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('mulDivRoundingUp: division by zero');
  const result = (a * b) / denominator;
  if ((a * b) % denominator > 0n) {
    return result + 1n;
  }
  return result;
}

/**
 * Returns the absolute value of a bigint.
 */
export function abs(a: bigint): bigint {
  return a < 0n ? -a : a;
}

/**
 * Returns the minimum of two bigints.
 */
export function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Returns the maximum of two bigints.
 */
export function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Computes the integer square root of a bigint using Newton's method.
 * @param value The value to compute the square root of.
 * @returns The floor of the square root.
 * @throws If value is negative.
 */
export function sqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('sqrt: negative value');
  if (value === 0n) return 0n;
  if (value <= 3n) return 1n;

  let x = value;
  let y = (x + 1n) / 2n;

  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }

  return x;
}

/**
 * Converts a number or string to a BigInt with the specified number of decimals.
 * @param value The value to convert (number or string, e.g., "1.5").
 * @param decimals The number of decimals for the token.
 * @returns The BigInt representation.
 */
export function toBigInt(value: number | string, decimals: number): bigint {
  const str = typeof value === 'number' ? value.toFixed(decimals + 2) : value;
  const parts = str.split('.');
  const intPart = parts[0] || '0';
  let fracPart = parts[1] || '';

  // Pad or truncate fractional part to match decimals
  if (fracPart.length > decimals) {
    fracPart = fracPart.substring(0, decimals);
  } else {
    fracPart = fracPart.padEnd(decimals, '0');
  }

  const combined = intPart + fracPart;
  // Remove leading zeros but keep at least one digit
  const cleaned = combined.replace(/^0+/, '') || '0';
  return BigInt(cleaned);
}

/**
 * Converts a BigInt to a number with the specified number of decimals.
 * @param value The BigInt value.
 * @param decimals The number of decimals.
 * @returns The number representation.
 */
export function fromBigInt(value: bigint, decimals: number): number {
  const divisor = 10n ** BigInt(decimals);
  const intPart = value / divisor;
  const fracPart = abs(value % divisor);
  const fracStr = fracPart.toString().padStart(decimals, '0');
  const sign = value < 0n ? '-' : '';
  return parseFloat(`${sign}${abs(intPart)}.${fracStr}`);
}

/**
 * Converts a BigInt to a human-readable string with the specified number of decimals.
 * @param value The BigInt value.
 * @param decimals The number of decimals.
 * @param displayDecimals The number of decimal places to show (default: 6).
 * @returns The formatted string.
 */
export function formatBigInt(value: bigint, decimals: number, displayDecimals: number = 6): string {
  const num = fromBigInt(value, decimals);
  return num.toFixed(displayDecimals);
}

/**
 * Scales a BigInt from one decimal precision to another.
 * @param value The BigInt value.
 * @param fromDecimals The current decimal precision.
 * @param toDecimals The target decimal precision.
 * @returns The scaled BigInt.
 */
export function scaleDecimals(value: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return value;
  if (toDecimals > fromDecimals) {
    return value * 10n ** BigInt(toDecimals - fromDecimals);
  }
  return value / 10n ** BigInt(fromDecimals - toDecimals);
}

/**
 * Computes the percentage of a BigInt value.
 * @param value The base value.
 * @param bps Basis points (e.g., 50 = 0.5%).
 * @returns The percentage amount.
 */
export function bpsOf(value: bigint, bps: bigint): bigint {
  return (value * bps) / 10000n;
}

/**
 * Checks if two BigInt values are within a tolerance of each other.
 * @param a First value.
 * @param b Second value.
 * @param toleranceBps Tolerance in basis points.
 * @returns True if the values are within tolerance.
 */
export function isWithinTolerance(a: bigint, b: bigint, toleranceBps: bigint): boolean {
  if (a === 0n && b === 0n) return true;
  const larger = max(abs(a), abs(b));
  const diff = abs(a - b);
  return diff * 10000n <= larger * toleranceBps;
}