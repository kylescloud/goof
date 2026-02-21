/**
 * @file AerodromeAdapter.ts
 * @description Adapter for Aerodrome Finance classic pools (stable + volatile). Handles the
 *              Aerodrome Route[] struct encoding for swaps. Differentiates between stable and
 *              volatile pool types. Implements getAmountOut using the Aerodrome pool's getAmountOut view.
 */

import { ethers } from 'ethers';
import { DexId, ProtocolVersion, AERODROME_POOL_ABI } from '../../config/constants';
import { BaseDexAdapter } from '../BaseDexAdapter';
import type { SwapParams, SwapCalldata, PoolState } from '../types';

const ROUTER_ABI = [
  'function swapExactTokensForTokens(uint256,uint256,(address from, address to, bool stable, address factory)[],address,uint256) returns (uint256[])',
  'function getAmountsOut(uint256,(address from, address to, bool stable, address factory)[]) view returns (uint256[])',
];

export class AerodromeAdapter extends BaseDexAdapter {
  readonly dexId = DexId.AERODROME;
  readonly name = 'Aerodrome';
  readonly version = ProtocolVersion.V2;

  constructor(provider: ethers.Provider, factoryAddress: string, routerAddress: string) {
    super(provider, factoryAddress, routerAddress, 'AerodromeAdapter');
  }

  async getAmountOut(params: SwapParams): Promise<bigint> {
    return this.retryCall(async () => {
      const pool = this.getContract(params.pool, AERODROME_POOL_ABI);
      const result = await pool.getAmountOut(params.amountIn, params.tokenIn);
      return BigInt(result);
    }, 'getAmountOut');
  }

  async buildSwapCalldata(params: SwapParams, recipient: string, deadline: number): Promise<SwapCalldata> {
    const router = this.getContract(this.routerAddress, ROUTER_ABI);
    const minOut = params.minAmountOut ?? 0n;

    // Determine if pool is stable
    const pool = this.getContract(params.pool, AERODROME_POOL_ABI);
    let isStable = false;
    try {
      isStable = await pool.stable();
    } catch {
      isStable = false;
    }

    const routes = [{
      from: params.tokenIn,
      to: params.tokenOut,
      stable: isStable,
      factory: this.factoryAddress,
    }];

    const data = router.interface.encodeFunctionData('swapExactTokensForTokens', [
      params.amountIn,
      minOut,
      routes,
      recipient,
      deadline,
    ]);

    return { to: this.routerAddress, data, value: 0n };
  }

  async getPoolState(poolAddress: string): Promise<PoolState> {
    return this.retryCall(async () => {
      const pool = this.getContract(poolAddress, AERODROME_POOL_ABI);
      const [token0, token1, stable, reserves] = await Promise.all([
        pool.token0(),
        pool.token1(),
        pool.stable(),
        pool.getReserves(),
      ]);

      return {
        address: poolAddress,
        token0: token0 as string,
        token1: token1 as string,
        dexId: this.dexId,
        version: this.version,
        reserve0: BigInt(reserves[0]),
        reserve1: BigInt(reserves[1]),
        stable: stable as boolean,
      };
    }, 'getPoolState');
  }

  async getReserves(poolAddress: string): Promise<{ reserve0: bigint; reserve1: bigint }> {
    return this.retryCall(async () => {
      const pool = this.getContract(poolAddress, AERODROME_POOL_ABI);
      const reserves = await pool.getReserves();
      return { reserve0: BigInt(reserves[0]), reserve1: BigInt(reserves[1]) };
    }, 'getReserves');
  }
}