/**
 * @file multicall/types.ts
 * @description Type definitions for the multicall module.
 */

export interface MulticallRequest {
  target: string;
  callData: string;
  allowFailure?: boolean;
}

export interface MulticallResult {
  success: boolean;
  returnData: string;
}

export interface DecodedMulticallResult<T> {
  success: boolean;
  data: T | null;
  error?: string;
}