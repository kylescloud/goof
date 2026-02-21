/**
 * @file addressUtils.ts
 * @description Address manipulation utilities: checksumAddress, sortTokens, pairKey,
 *              isZeroAddress. Used throughout the bot for consistent address handling.
 */

import { ethers } from 'ethers';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Returns the checksummed version of an Ethereum address.
 * @param address The address to checksum.
 * @returns The checksummed address.
 */
export function checksumAddress(address: string): string {
  try {
    return ethers.getAddress(address);
  } catch {
    return address;
  }
}

/**
 * Sorts two token addresses in ascending order (lower address first).
 * This matches the Uniswap convention for token0/token1 ordering.
 * @param tokenA First token address.
 * @param tokenB Second token address.
 * @returns Tuple of [lower, higher] addresses.
 */
export function sortTokens(tokenA: string, tokenB: string): [string, string] {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  return a < b ? [tokenA, tokenB] : [tokenB, tokenA];
}

/**
 * Creates a consistent pair key from two token addresses, regardless of order.
 * @param tokenA First token address.
 * @param tokenB Second token address.
 * @returns A string key in the format "lowerAddress-higherAddress".
 */
export function pairKey(tokenA: string, tokenB: string): string {
  const [sorted0, sorted1] = sortTokens(tokenA, tokenB);
  return `${sorted0.toLowerCase()}-${sorted1.toLowerCase()}`;
}

/**
 * Checks if an address is the zero address.
 * @param address The address to check.
 * @returns True if the address is the zero address.
 */
export function isZeroAddress(address: string): boolean {
  return address === ZERO_ADDRESS || address === '0x' + '0'.repeat(40);
}

/**
 * Checks if a string is a valid Ethereum address.
 * @param address The string to check.
 * @returns True if the string is a valid address.
 */
export function isValidAddress(address: string): boolean {
  try {
    ethers.getAddress(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compares two addresses for equality (case-insensitive).
 * @param a First address.
 * @param b Second address.
 * @returns True if the addresses are equal.
 */
export function addressEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Shortens an address for display purposes.
 * @param address The full address.
 * @param chars Number of characters to show on each side (default 4).
 * @returns Shortened address like "0x1234...5678".
 */
export function shortenAddress(address: string, chars: number = 4): string {
  if (address.length < 2 + chars * 2) return address;
  return `${address.substring(0, chars + 2)}...${address.substring(address.length - chars)}`;
}

/**
 * Creates a unique pool identifier from pool address and DEX name.
 * @param poolAddress The pool contract address.
 * @param dexName The DEX name.
 * @returns A unique pool key.
 */
export function poolKey(poolAddress: string, dexName: string): string {
  return `${dexName}:${poolAddress.toLowerCase()}`;
}