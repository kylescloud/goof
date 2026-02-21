/**
 * @file tokenUtils.ts
 * @description Token metadata utilities: getTokenDecimals, getTokenSymbol, normalizeAmount.
 *              Caches ERC20 metadata lookups to avoid redundant RPC calls.
 */

import { ethers } from 'ethers';
import { MINIMAL_ERC20_ABI } from '../config/constants';
import { TOKEN_BY_ADDRESS, type TokenInfo } from '../config/addresses';
import { createModuleLogger } from './logger';

const logger = createModuleLogger('tokenUtils');

// In-memory cache for token metadata
const tokenMetadataCache: Map<string, { decimals: number; symbol: string; name: string }> = new Map();

/**
 * Initializes the cache with known tokens from the address registry.
 */
function initializeCache(): void {
  for (const [address, info] of Object.entries(TOKEN_BY_ADDRESS)) {
    tokenMetadataCache.set(address.toLowerCase(), {
      decimals: info.decimals,
      symbol: info.symbol,
      name: info.symbol,
    });
  }
}

// Initialize on module load
initializeCache();

/**
 * Gets the decimals for a token, using cache first, then RPC.
 * @param address The token address.
 * @param provider The ethers provider.
 * @returns The number of decimals.
 */
export async function getTokenDecimals(address: string, provider: ethers.Provider): Promise<number> {
  const key = address.toLowerCase();

  const cached = tokenMetadataCache.get(key);
  if (cached) return cached.decimals;

  try {
    const contract = new ethers.Contract(address, MINIMAL_ERC20_ABI, provider);
    const decimals = await contract.decimals();
    const symbol = await contract.symbol().catch(() => 'UNKNOWN');
    const name = await contract.name().catch(() => 'Unknown Token');

    tokenMetadataCache.set(key, {
      decimals: Number(decimals),
      symbol: String(symbol),
      name: String(name),
    });

    return Number(decimals);
  } catch (error) {
    logger.warn('Failed to fetch token decimals', { address, error: (error as Error).message });
    return 18; // Default to 18 decimals
  }
}

/**
 * Gets the symbol for a token, using cache first, then RPC.
 * @param address The token address.
 * @param provider The ethers provider.
 * @returns The token symbol.
 */
export async function getTokenSymbol(address: string, provider: ethers.Provider): Promise<string> {
  const key = address.toLowerCase();

  const cached = tokenMetadataCache.get(key);
  if (cached) return cached.symbol;

  try {
    const contract = new ethers.Contract(address, MINIMAL_ERC20_ABI, provider);
    const symbol = await contract.symbol();
    const decimals = await contract.decimals().catch(() => 18);
    const name = await contract.name().catch(() => 'Unknown Token');

    tokenMetadataCache.set(key, {
      decimals: Number(decimals),
      symbol: String(symbol),
      name: String(name),
    });

    return String(symbol);
  } catch (error) {
    logger.warn('Failed to fetch token symbol', { address, error: (error as Error).message });
    return 'UNKNOWN';
  }
}

/**
 * Gets full token info from cache or fetches from chain.
 * @param address The token address.
 * @param provider The ethers provider.
 * @returns TokenInfo object.
 */
export async function getTokenInfo(address: string, provider: ethers.Provider): Promise<TokenInfo> {
  const key = address.toLowerCase();

  // Check static registry first
  const staticInfo = TOKEN_BY_ADDRESS[key];
  if (staticInfo) return staticInfo;

  // Check cache
  const cached = tokenMetadataCache.get(key);
  if (cached) {
    return { address, symbol: cached.symbol, decimals: cached.decimals };
  }

  // Fetch from chain
  const decimals = await getTokenDecimals(address, provider);
  const symbol = await getTokenSymbol(address, provider);

  return { address, symbol, decimals };
}

/**
 * Normalizes a token amount from one decimal precision to another.
 * @param amount The amount as a BigInt.
 * @param fromDecimals The source decimal precision.
 * @param toDecimals The target decimal precision.
 * @returns The normalized amount.
 */
export function normalizeAmount(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return amount;
  if (toDecimals > fromDecimals) {
    return amount * 10n ** BigInt(toDecimals - fromDecimals);
  }
  return amount / 10n ** BigInt(fromDecimals - toDecimals);
}

/**
 * Checks if a token address is in the known token registry.
 * @param address The token address.
 * @returns True if the token is known.
 */
export function isKnownToken(address: string): boolean {
  return TOKEN_BY_ADDRESS[address.toLowerCase()] !== undefined;
}

/**
 * Gets the cached metadata for a token, or undefined if not cached.
 * @param address The token address.
 * @returns The cached metadata or undefined.
 */
export function getCachedTokenMetadata(address: string): { decimals: number; symbol: string } | undefined {
  return tokenMetadataCache.get(address.toLowerCase());
}

/**
 * Clears the token metadata cache.
 */
export function clearTokenCache(): void {
  tokenMetadataCache.clear();
  initializeCache();
}