/**
 * @file oracle/types.ts
 * @description Type definitions for the oracle module.
 */

export interface OraclePrice {
  price: bigint;         // Price in USD with 18 decimals precision
  decimals: number;      // Feed decimals (usually 8)
  rawAnswer: bigint;     // Raw answer from Chainlink
  updatedAt: number;     // Unix timestamp of last update
  roundId: bigint;       // Round ID
  isStale: boolean;      // Whether the price is considered stale
}

export interface TokenPriceUSD {
  tokenAddress: string;
  priceUsd: number;      // Human-readable USD price
  priceBigInt: bigint;   // Price with 18 decimals
  timestamp: number;     // When this price was fetched
}

export interface PoolTVL {
  poolAddress: string;
  tvlUsd: number;
  token0Usd: number;
  token1Usd: number;
}