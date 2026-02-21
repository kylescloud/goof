/**
 * @file BaseswapV2Adapter.ts
 * @description Adapter for BaseSwap V2. Identical logic to UniswapV2Adapter with BaseSwap-specific addresses.
 */

import { ethers } from 'ethers';
import { DexId, ProtocolVersion, V2_PAIR_ABI } from '../../config/constants';
import { BaseDexAdapter } from '../BaseDexAdapter';
import { getAmountOut as v2GetAmountOut } from '../math/V2Math';
import type { SwapParams, SwapCalldata, PoolState } from '../types';

const ROUTER_ABI = [
  'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])',
];

export class BaseswapV2Adapter extends BaseDexAdapter {
  readonly dexId = DexId.BASESWAP_V2;
  readonly name = 'BaseSwap V2';
  readonly version = ProtocolVersion.V2;

  constructor(provider: ethers.Provider, factoryAddress: string, routerAddress: string) {
    super(provider, factoryAddress, routerAddress, 'BaseswapV2Adapter');
  }

  async getAmountOut(params: SwapParams): Promise<bigint> {
    return this.retryCall(async () => {
      const pair = this.getContract(params.pool, V2_PAIR_ABI);
      const [reserve0, reserve1] = await pair.getReserves();
      const token0 = await pair.token0();
      const isToken0In = params.tokenIn.toLowerCase() === token0.toLowerCase();
      const reserveIn = isToken0In ? BigInt(reserve0) : BigInt(reserve1);
      const reserveOut = isToken0In ? BigInt(reserve1) : BigInt(reserve0);
      return v2GetAmountOut(params.amountIn, reserveIn, reserveOut, 30);
    }, 'getAmountOut');
  }

  async buildSwapCalldata(params: SwapParams, recipient: string, deadline: number): Promise<SwapCalldata> {
    const router = this.getContract(this.routerAddress, ROUTER_ABI);
    const minOut = params.minAmountOut ?? 0n;
    const data = router.interface.encodeFunctionData('swapExactTokensForTokens', [
      params.amountIn, minOut, [params.tokenIn, params.tokenOut], recipient, deadline,
    ]);
    return { to: this.routerAddress, data, value: 0n };
  }

  async getPoolState(poolAddress: string): Promise<PoolState> {
    return this.retryCall(async () => {
      const pair = this.getContract(poolAddress, V2_PAIR_ABI);
      const [token0, token1, reserves] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves()]);
      return {
        address: poolAddress, token0: token0 as string, token1: token1 as string,
        dexId: this.dexId, version: this.version,
        reserve0: BigInt(reserves[0]), reserve1: BigInt(reserves[1]),
      };
    }, 'getPoolState');
  }

  async getReserves(poolAddress: string): Promise<{ reserve0: bigint; reserve1: bigint }> {
    return this.retryCall(async () => {
      const pair = this.getContract(poolAddress, V2_PAIR_ABI);
      const reserves = await pair.getReserves();
      return { reserve0: BigInt(reserves[0]), reserve1: BigInt(reserves[1]) };
    }, 'getReserves');
  }
}