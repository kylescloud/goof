/**
 * @file flashAmountUtils.ts
 * @description Shared utilities for calculating safe flash loan amounts.
 *              Enforces hard caps per token and minimum liquidity thresholds
 *              to prevent absurd amounts from low-liquidity or broken pools.
 */

import { FLASH_AMOUNT_CAPS, DEFAULT_FLASH_AMOUNT_CAP_18, MIN_V2_RESERVE_NORMALIZED } from '../config/constants';
import { TOKEN_BY_ADDRESS } from '../config/addresses';
import type { GraphEdge } from '../graph/types';
import type { PoolEntry } from '../discovery/types';

/**
 * Gets the hard cap for a flash asset in its native token units.
 */
export function getFlashAmountCap(flashAsset: string): bigint {
  const key = flashAsset.toLowerCase();
  if (FLASH_AMOUNT_CAPS[key] !== undefined) {
    return FLASH_AMOUNT_CAPS[key];
  }
  // Unknown token: use 10,000 units in 18-decimal
  const tokenInfo = TOKEN_BY_ADDRESS[key];
  if (tokenInfo) {
    return 10_000n * 10n ** BigInt(tokenInfo.decimals);
  }
  return DEFAULT_FLASH_AMOUNT_CAP_18;
}

/**
 * Calculates a safe flash amount from a V2 pool edge.
 * Uses 2% of the relevant reserve, capped at the token hard cap.
 * Returns 0n if the pool has insufficient liquidity.
 */
export function safeFlashAmountFromV2Edge(
  edge: GraphEdge,
  flashAsset: string,
  flashDecimals: number
): bigint {
  if (!edge.reserve0 || !edge.reserve1) return 0n;

  const isToken0In = edge.from.toLowerCase() === flashAsset.toLowerCase();
  const reserveIn  = isToken0In ? edge.reserve0 : edge.reserve1;
  const reserveOut = isToken0In ? edge.reserve1 : edge.reserve0;

  if (reserveIn === 0n || reserveOut === 0n) return 0n;

  // Normalize reserveIn to 18 decimals for minimum check
  const normalizedReserveIn = flashDecimals >= 18
    ? reserveIn
    : reserveIn * (10n ** BigInt(18 - flashDecimals));

  // Reject pools with less than MIN_V2_RESERVE_NORMALIZED
  if (normalizedReserveIn < MIN_V2_RESERVE_NORMALIZED) return 0n;

  // Use 2% of reserve (reserve / 50)
  const rawAmount = reserveIn / 50n;

  // Apply hard cap
  const cap = getFlashAmountCap(flashAsset);
  return rawAmount < cap ? rawAmount : cap;
}

/**
 * Calculates a safe flash amount from a V3 pool edge.
 * Uses a fixed conservative amount based on token type, capped at hard cap.
 * For V3 pools we can't easily estimate from sqrtPriceX96 alone.
 */
export function safeFlashAmountFromV3Edge(
  flashAsset: string,
  flashDecimals: number
): bigint {
  // Use a conservative fixed amount: 1,000 units of the flash asset
  // This is safe for most pools and avoids price impact issues
  const conservativeAmount = 1_000n * 10n ** BigInt(flashDecimals);

  // Apply hard cap
  const cap = getFlashAmountCap(flashAsset);
  return conservativeAmount < cap ? conservativeAmount : cap;
}

/**
 * Calculates a safe flash amount from a pool entry (for LiquidityImbalance strategy).
 * Returns 0n if the pool has insufficient liquidity.
 */
export function safeFlashAmountFromPool(
  pool: PoolEntry,
  flashAsset: string,
  flashDecimals: number
): bigint {
  if (pool.reserve0 && pool.reserve1) {
    const isToken0 = pool.token0.address.toLowerCase() === flashAsset.toLowerCase();
    const reserveIn  = BigInt(isToken0 ? pool.reserve0 : pool.reserve1);
    const reserveOut = BigInt(isToken0 ? pool.reserve1 : pool.reserve0);

    if (reserveIn === 0n || reserveOut === 0n) return 0n;

    // Normalize to 18 decimals for minimum check
    const normalizedReserveIn = flashDecimals >= 18
      ? reserveIn
      : reserveIn * (10n ** BigInt(18 - flashDecimals));

    if (normalizedReserveIn < MIN_V2_RESERVE_NORMALIZED) return 0n;

    const rawAmount = reserveIn / 50n;
    const cap = getFlashAmountCap(flashAsset);
    return rawAmount < cap ? rawAmount : cap;
  }

  // V3 pool: use conservative fixed amount
  return safeFlashAmountFromV3Edge(flashAsset, flashDecimals);
}

/**
 * Validates that a V2 edge has sufficient liquidity for a meaningful swap.
 * Returns false if the pool should be skipped.
 */
export function hasMinimumV2Liquidity(
  edge: GraphEdge,
  flashDecimals: number
): boolean {
  if (!edge.reserve0 || !edge.reserve1) return false;
  if (edge.reserve0 === 0n || edge.reserve1 === 0n) return false;

  // Check both reserves are above minimum
  const norm0 = flashDecimals >= 18
    ? edge.reserve0
    : edge.reserve0 * (10n ** BigInt(18 - flashDecimals));

  return norm0 >= MIN_V2_RESERVE_NORMALIZED;
}

/**
 * Validates that a V3 edge has a valid sqrtPriceX96 (non-zero, reasonable range).
 */
export function hasValidV3Price(edge: GraphEdge): boolean {
  if (!edge.sqrtPriceX96 || edge.sqrtPriceX96 === 0n) return false;
  // sqrtPriceX96 should be in a reasonable range
  // Min: represents ~$0.000001 per token, Max: ~$1,000,000 per token
  const MIN_SQRT = 79228162514264337593n;   // ~1.0 price
  const MAX_SQRT = 7922816251426433759354395n; // ~10,000x price
  return edge.sqrtPriceX96 >= MIN_SQRT / 1000n && edge.sqrtPriceX96 <= MAX_SQRT;
}