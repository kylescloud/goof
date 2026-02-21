/**
 * @file dex/types.ts
 * @description TypeScript type definitions for the DEX adapter module.
 */

import { DexId, ProtocolVersion } from '../config/constants';

export interface SwapQuote {
  amountOut: bigint;
  gasEstimate: bigint;
  priceImpactBps: number;
  route: string[];
}

export interface PoolState {
  address: string;
  token0: string;
  token1: string;
  dexId: DexId;
  version: ProtocolVersion;
  // V2 state
  reserve0?: bigint;
  reserve1?: bigint;
  // V3 state
  sqrtPriceX96?: bigint;
  tick?: number;
  liquidity?: bigint;
  fee?: number;
  tickSpacing?: number;
  // Aerodrome-specific
  stable?: boolean;
}

export interface SwapParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  pool: string;
  fee?: number;
  minAmountOut?: bigint;
}

export interface SwapCalldata {
  to: string;
  data: string;
  value: bigint;
}

export interface IDexAdapter {
  readonly dexId: DexId;
  readonly name: string;
  readonly version: ProtocolVersion;

  /**
   * Gets the expected output amount for a swap.
   */
  getAmountOut(params: SwapParams): Promise<bigint>;

  /**
   * Builds the calldata for executing a swap on-chain.
   */
  buildSwapCalldata(params: SwapParams, recipient: string, deadline: number): Promise<SwapCalldata>;

  /**
   * Gets the current state of a pool.
   */
  getPoolState(poolAddress: string): Promise<PoolState>;

  /**
   * Gets the reserves for a V2 pool.
   */
  getReserves?(poolAddress: string): Promise<{ reserve0: bigint; reserve1: bigint }>;

  /**
   * Gets the factory address for this DEX.
   */
  getFactoryAddress(): string;

  /**
   * Gets the router address for this DEX.
   */
  getRouterAddress(): string;
}

export interface ZeroXQuote {
  buyAmount: string;
  sellAmount: string;
  gasEstimate: string;
  allowanceTarget: string;
  to: string;
  data: string;
  value: string;
  price: string;
  guaranteedPrice: string;
  sources: Array<{ name: string; proportion: string }>;
  fees: {
    zeroExFee: { amount: string; token: string; type: string } | null;
  };
}

export interface DexConfig {
  dexId: DexId;
  name: string;
  version: ProtocolVersion;
  factoryAddress: string;
  routerAddress: string;
  quoterAddress?: string;
  deployBlock: number;
  feeTiers?: readonly number[];
  tickSpacings?: readonly number[];
}