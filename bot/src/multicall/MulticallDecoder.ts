/**
 * @file MulticallDecoder.ts
 * @description Decodes the raw bytes returned by Multicall3 for each sub-call.
 *              Handles success and failure states per sub-call. Uses ABI decoders
 *              appropriate to the call type.
 */

import { ethers } from 'ethers';
import type { MulticallResult, DecodedMulticallResult } from './types';

export class MulticallDecoder {
  /**
   * Decodes a single multicall result using the provided ABI fragment.
   * @param result The raw multicall result.
   * @param abiFragment The ABI fragment string for decoding (e.g., "function token0() view returns (address)").
   * @returns The decoded result.
   */
  static decode<T>(result: MulticallResult, abiFragment: string): DecodedMulticallResult<T> {
    if (!result.success || result.returnData === '0x') {
      return { success: false, data: null, error: 'Call failed or returned empty data' };
    }

    try {
      const iface = new ethers.Interface([abiFragment]);
      const functionName = abiFragment.match(/function\s+(\w+)/)?.[1];
      if (!functionName) {
        return { success: false, data: null, error: 'Could not parse function name from ABI' };
      }

      const decoded = iface.decodeFunctionResult(functionName, result.returnData);

      // If single return value, unwrap from Result
      if (decoded.length === 1) {
        return { success: true, data: decoded[0] as T };
      }

      return { success: true, data: decoded as unknown as T };
    } catch (error) {
      return {
        success: false,
        data: null,
        error: `Decode error: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Decodes a multicall result that returns an address.
   */
  static decodeAddress(result: MulticallResult): DecodedMulticallResult<string> {
    return MulticallDecoder.decode<string>(result, 'function fn() view returns (address)');
  }

  /**
   * Decodes a multicall result that returns a uint256.
   */
  static decodeUint256(result: MulticallResult): DecodedMulticallResult<bigint> {
    if (!result.success || result.returnData === '0x') {
      return { success: false, data: null, error: 'Call failed' };
    }

    try {
      const value = BigInt(result.returnData);
      return { success: true, data: value };
    } catch {
      try {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], result.returnData);
        return { success: true, data: decoded[0] as bigint };
      } catch (error) {
        return { success: false, data: null, error: `Decode error: ${(error as Error).message}` };
      }
    }
  }

  /**
   * Decodes a multicall result that returns a uint8 (e.g., decimals).
   */
  static decodeUint8(result: MulticallResult): DecodedMulticallResult<number> {
    if (!result.success || result.returnData === '0x') {
      return { success: false, data: null, error: 'Call failed' };
    }

    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['uint8'], result.returnData);
      return { success: true, data: Number(decoded[0]) };
    } catch (error) {
      return { success: false, data: null, error: `Decode error: ${(error as Error).message}` };
    }
  }

  /**
   * Decodes a multicall result that returns a string (e.g., symbol).
   */
  static decodeString(result: MulticallResult): DecodedMulticallResult<string> {
    if (!result.success || result.returnData === '0x') {
      return { success: false, data: null, error: 'Call failed' };
    }

    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['string'], result.returnData);
      return { success: true, data: decoded[0] as string };
    } catch (error) {
      return { success: false, data: null, error: `Decode error: ${(error as Error).message}` };
    }
  }

  /**
   * Decodes V2 pair getReserves() result.
   */
  static decodeReserves(result: MulticallResult): DecodedMulticallResult<{
    reserve0: bigint;
    reserve1: bigint;
    blockTimestampLast: number;
  }> {
    if (!result.success || result.returnData === '0x') {
      return { success: false, data: null, error: 'Call failed' };
    }

    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ['uint112', 'uint112', 'uint32'],
        result.returnData
      );
      return {
        success: true,
        data: {
          reserve0: decoded[0] as bigint,
          reserve1: decoded[1] as bigint,
          blockTimestampLast: Number(decoded[2]),
        },
      };
    } catch (error) {
      return { success: false, data: null, error: `Decode error: ${(error as Error).message}` };
    }
  }

  /**
   * Decodes V3 pool slot0() result.
   */
  static decodeSlot0(result: MulticallResult): DecodedMulticallResult<{
    sqrtPriceX96: bigint;
    tick: number;
    observationIndex: number;
    observationCardinality: number;
    observationCardinalityNext: number;
    feeProtocol: number;
    unlocked: boolean;
  }> {
    if (!result.success || result.returnData === '0x') {
      return { success: false, data: null, error: 'Call failed' };
    }

    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool'],
        result.returnData
      );
      return {
        success: true,
        data: {
          sqrtPriceX96: decoded[0] as bigint,
          tick: Number(decoded[1]),
          observationIndex: Number(decoded[2]),
          observationCardinality: Number(decoded[3]),
          observationCardinalityNext: Number(decoded[4]),
          feeProtocol: Number(decoded[5]),
          unlocked: decoded[6] as boolean,
        },
      };
    } catch (error) {
      return { success: false, data: null, error: `Decode error: ${(error as Error).message}` };
    }
  }

  /**
   * Decodes Aerodrome CL pool slot0() result (6 fields, no feeProtocol).
   */
  static decodeAeroCLSlot0(result: MulticallResult): DecodedMulticallResult<{
    sqrtPriceX96: bigint;
    tick: number;
    observationIndex: number;
    observationCardinality: number;
    observationCardinalityNext: number;
    unlocked: boolean;
  }> {
    if (!result.success || result.returnData === '0x') {
      return { success: false, data: null, error: 'Call failed' };
    }

    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'bool'],
        result.returnData
      );
      return {
        success: true,
        data: {
          sqrtPriceX96: decoded[0] as bigint,
          tick: Number(decoded[1]),
          observationIndex: Number(decoded[2]),
          observationCardinality: Number(decoded[3]),
          observationCardinalityNext: Number(decoded[4]),
          unlocked: decoded[5] as boolean,
        },
      };
    } catch (error) {
      return { success: false, data: null, error: `Decode error: ${(error as Error).message}` };
    }
  }

  /**
   * Decodes a bool return value.
   */
  static decodeBool(result: MulticallResult): DecodedMulticallResult<boolean> {
    if (!result.success || result.returnData === '0x') {
      return { success: false, data: null, error: 'Call failed' };
    }

    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['bool'], result.returnData);
      return { success: true, data: decoded[0] as boolean };
    } catch (error) {
      return { success: false, data: null, error: `Decode error: ${(error as Error).message}` };
    }
  }
}