/**
 * @file BaseswapV3Adapter.ts
 * @description Adapter for BaseSwap V3. Identical logic to UniswapV3Adapter with BaseSwap-specific addresses.
 */

import { ethers } from 'ethers';
import { DexId, ProtocolVersion, V3_POOL_ABI } from '../../config/constants';
import { BaseDexAdapter } from '../BaseDexAdapter';
import type { SwapParams, SwapCalldata, PoolState } from '../types';

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)',
];

export class BaseswapV3Adapter extends BaseDexAdapter {
  readonly dexId = DexId.BASESWAP_V3;
  readonly name = 'BaseSwap V3';
  readonly version = ProtocolVersion.V3;
  protected quoterAddress: string;

  constructor(provider: ethers.Provider, factoryAddress: string, routerAddress: string, quoterAddress: string) {
    super(provider, factoryAddress, routerAddress, 'BaseswapV3Adapter');
    this.quoterAddress = quoterAddress;
  }

  async getAmountOut(params: SwapParams): Promise<bigint> {
    return this.retryCall(async () => {
      const quoter = this.getContract(this.quoterAddress, QUOTER_ABI);
      const fee = params.fee ?? 2500;
      try {
        const result = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: params.tokenIn, tokenOut: params.tokenOut,
          amountIn: params.amountIn, fee, sqrtPriceLimitX96: 0,
        });
        return BigInt(result.amountOut);
      } catch {
        return this._approximateFromPoolState(params);
      }
    }, 'getAmountOut');
  }

  async buildSwapCalldata(params: SwapParams, recipient: string, deadline: number): Promise<SwapCalldata> {
    const router = this.getContract(this.routerAddress, ROUTER_ABI);
    const fee = params.fee ?? 2500;
    const minOut = params.minAmountOut ?? 0n;
    const data = router.interface.encodeFunctionData('exactInputSingle', [{
      tokenIn: params.tokenIn, tokenOut: params.tokenOut, fee, recipient, deadline,
      amountIn: params.amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0,
    }]);
    return { to: this.routerAddress, data, value: 0n };
  }

  async getPoolState(poolAddress: string): Promise<PoolState> {
    return this.retryCall(async () => {
      const pool = this.getContract(poolAddress, V3_POOL_ABI);
      const [token0, token1, fee, slot0Data, liq] = await Promise.all([
        pool.token0(), pool.token1(), pool.fee(), pool.slot0(), pool.liquidity(),
      ]);
      return {
        address: poolAddress, token0: token0 as string, token1: token1 as string,
        dexId: this.dexId, version: this.version, fee: Number(fee),
        sqrtPriceX96: BigInt(slot0Data[0]), tick: Number(slot0Data[1]), liquidity: BigInt(liq),
      };
    }, 'getPoolState');
  }

  private async _approximateFromPoolState(params: SwapParams): Promise<bigint> {
    try {
      const pool = this.getContract(params.pool, V3_POOL_ABI);
      const [slot0Data, token0] = await Promise.all([pool.slot0(), pool.token0()]);
      const sqrtPriceX96 = BigInt(slot0Data[0]);
      const fee = params.fee ?? 2500;
      if (sqrtPriceX96 === 0n) return 0n;
      const zeroForOne = params.tokenIn.toLowerCase() === (token0 as string).toLowerCase();
      const amountInAfterFee = (params.amountIn * BigInt(1000000 - fee)) / 1000000n;
      if (zeroForOne) {
        return (amountInAfterFee * sqrtPriceX96 * sqrtPriceX96) >> 192n;
      } else {
        const priceNum = sqrtPriceX96 * sqrtPriceX96;
        if (priceNum === 0n) return 0n;
        return (amountInAfterFee << 192n) / priceNum;
      }
    } catch { return 0n; }
  }
}