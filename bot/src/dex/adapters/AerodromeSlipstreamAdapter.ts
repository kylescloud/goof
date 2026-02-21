/**
 * @file AerodromeSlipstreamAdapter.ts
 * @description Adapter for Aerodrome Slipstream (CL) pools. Handles the Slipstream-specific
 *              tick spacing instead of fee tiers. Uses the Slipstream quoter and router.
 */

import { ethers } from 'ethers';
import { DexId, ProtocolVersion, AERODROME_CL_POOL_ABI } from '../../config/constants';
import { BaseDexAdapter } from '../BaseDexAdapter';
import type { SwapParams, SwapCalldata, PoolState } from '../types';

const CL_QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const CL_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)',
];

export class AerodromeSlipstreamAdapter extends BaseDexAdapter {
  readonly dexId = DexId.AERODROME_SLIPSTREAM;
  readonly name = 'Aerodrome Slipstream';
  readonly version = ProtocolVersion.V3;
  protected quoterAddress: string;

  constructor(provider: ethers.Provider, factoryAddress: string, routerAddress: string, quoterAddress: string) {
    super(provider, factoryAddress, routerAddress, 'AerodromeSlipstreamAdapter');
    this.quoterAddress = quoterAddress;
  }

  async getAmountOut(params: SwapParams): Promise<bigint> {
    return this.retryCall(async () => {
      const quoter = this.getContract(this.quoterAddress, CL_QUOTER_ABI);

      // Get tick spacing from pool
      const pool = this.getContract(params.pool, AERODROME_CL_POOL_ABI);
      const tickSpacing = await pool.tickSpacing();

      try {
        const result = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          amountIn: params.amountIn,
          tickSpacing: Number(tickSpacing),
          sqrtPriceLimitX96: 0,
        });
        return BigInt(result.amountOut);
      } catch {
        return this._approximateFromPoolState(params);
      }
    }, 'getAmountOut');
  }

  async buildSwapCalldata(params: SwapParams, recipient: string, deadline: number): Promise<SwapCalldata> {
    const router = this.getContract(this.routerAddress, CL_ROUTER_ABI);
    const minOut = params.minAmountOut ?? 0n;

    // Get tick spacing from pool
    const pool = this.getContract(params.pool, AERODROME_CL_POOL_ABI);
    const tickSpacing = await pool.tickSpacing();

    const data = router.interface.encodeFunctionData('exactInputSingle', [{
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      tickSpacing: Number(tickSpacing),
      recipient,
      deadline,
      amountIn: params.amountIn,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0,
    }]);

    return { to: this.routerAddress, data, value: 0n };
  }

  async getPoolState(poolAddress: string): Promise<PoolState> {
    return this.retryCall(async () => {
      const pool = this.getContract(poolAddress, AERODROME_CL_POOL_ABI);
      const [token0, token1, tickSpacing, slot0Data, liq] = await Promise.all([
        pool.token0(), pool.token1(), pool.tickSpacing(), pool.slot0(), pool.liquidity(),
      ]);

      let fee = 0;
      try {
        fee = Number(await pool.fee());
      } catch {
        // Some Slipstream pools may not expose fee()
      }

      return {
        address: poolAddress,
        token0: token0 as string,
        token1: token1 as string,
        dexId: this.dexId,
        version: this.version,
        fee,
        tickSpacing: Number(tickSpacing),
        sqrtPriceX96: BigInt(slot0Data[0]),
        tick: Number(slot0Data[1]),
        liquidity: BigInt(liq),
      };
    }, 'getPoolState');
  }

  private async _approximateFromPoolState(params: SwapParams): Promise<bigint> {
    try {
      const pool = this.getContract(params.pool, AERODROME_CL_POOL_ABI);
      const [slot0Data, token0] = await Promise.all([pool.slot0(), pool.token0()]);
      const sqrtPriceX96 = BigInt(slot0Data[0]);
      if (sqrtPriceX96 === 0n) return 0n;

      const fee = params.fee ?? 500;
      const zeroForOne = params.tokenIn.toLowerCase() === (token0 as string).toLowerCase();
      const amountInAfterFee = (params.amountIn * BigInt(1000000 - fee)) / 1000000n;

      if (zeroForOne) {
        return (amountInAfterFee * sqrtPriceX96 * sqrtPriceX96) >> 192n;
      } else {
        const priceNum = sqrtPriceX96 * sqrtPriceX96;
        if (priceNum === 0n) return 0n;
        return (amountInAfterFee << 192n) / priceNum;
      }
    } catch {
      return 0n;
    }
  }
}