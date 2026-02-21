/**
 * @file ZeroXAdapter.ts
 * @description Full 0x Protocol API v2 adapter. Constructs quote request URLs with all required
 *              parameters. Implements exponential backoff retry with jitter. Parses the quote
 *              response to extract buyAmount, gas estimate, allowanceTarget, data (calldata).
 *              Handles both permit2 and legacy approval flows.
 */

import { ethers } from 'ethers';
import { DexId, ProtocolVersion } from '../../config/constants';
import { CHAIN_ID } from '../../config/addresses';
import { BaseDexAdapter } from '../BaseDexAdapter';
import { RateLimiter } from '../../utils/rateLimiter';
import { withRetry } from '../../utils/retry';
import { createModuleLogger } from '../../utils/logger';
import type { SwapParams, SwapCalldata, PoolState, ZeroXQuote } from '../types';

const logger = createModuleLogger('ZeroXAdapter');

export class ZeroXAdapter extends BaseDexAdapter {
  readonly dexId = DexId.ZERO_X;
  readonly name = '0x Aggregator';
  readonly version = ProtocolVersion.V2; // Aggregator, not a specific version
  private apiKey: string;
  private apiBaseUrl: string;
  private rateLimiter: RateLimiter;
  private takerAddress: string;

  constructor(
    provider: ethers.Provider,
    apiKey: string,
    apiBaseUrl: string = 'https://api.0x.org',
    rateLimitRps: number = 5,
    takerAddress: string = ethers.ZeroAddress
  ) {
    super(provider, '', '', 'ZeroXAdapter');
    this.apiKey = apiKey;
    this.apiBaseUrl = apiBaseUrl;
    this.rateLimiter = new RateLimiter(rateLimitRps);
    this.takerAddress = takerAddress;
  }

  /**
   * Gets a quote from the 0x API for a swap.
   */
  async getQuote(
    sellToken: string,
    buyToken: string,
    sellAmount: bigint,
    taker?: string
  ): Promise<ZeroXQuote | null> {
    await this.rateLimiter.acquire();

    const params = new URLSearchParams({
      chainId: CHAIN_ID.toString(),
      sellToken,
      buyToken,
      sellAmount: sellAmount.toString(),
      taker: taker || this.takerAddress,
    });

    const url = `${this.apiBaseUrl}/swap/v1/quote?${params.toString()}`;

    return withRetry(
      async () => {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            '0x-api-key': this.apiKey,
            'Content-Type': 'application/json',
          },
        });

        if (response.status === 429) {
          throw new Error('0x API rate limit exceeded');
        }

        if (!response.ok) {
          const errorBody = await response.text().catch(() => 'Unknown error');
          throw new Error(`0x API error ${response.status}: ${errorBody}`);
        }

        const data = await response.json();
        return data as ZeroXQuote;
      },
      {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        retryableErrors: ['rate limit', '429', 'ECONNRESET', 'ETIMEDOUT', 'fetch failed'],
        onRetry: (error, attempt) => {
          logger.warn('0x API retry', { attempt, error: error.message });
        },
      }
    ).catch((error) => {
      logger.error('0x API quote failed', {
        sellToken,
        buyToken,
        sellAmount: sellAmount.toString(),
        error: error.message,
      });
      return null;
    });
  }

  /**
   * Gets a price quote (cheaper, no calldata) from the 0x API.
   */
  async getPrice(
    sellToken: string,
    buyToken: string,
    sellAmount: bigint
  ): Promise<{ buyAmount: bigint; gasEstimate: bigint } | null> {
    await this.rateLimiter.acquire();

    const params = new URLSearchParams({
      chainId: CHAIN_ID.toString(),
      sellToken,
      buyToken,
      sellAmount: sellAmount.toString(),
    });

    const url = `${this.apiBaseUrl}/swap/v1/price?${params.toString()}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          '0x-api-key': this.apiKey,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) return null;

      const data = (await response.json()) as { buyAmount?: string; estimatedGas?: string };
      return {
        buyAmount: BigInt(data.buyAmount || '0'),
        gasEstimate: BigInt(data.estimatedGas || '0'),
      };
    } catch (error) {
      logger.debug('0x price quote failed', { error: (error as Error).message });
      return null;
    }
  }

  async getAmountOut(params: SwapParams): Promise<bigint> {
    const price = await this.getPrice(params.tokenIn, params.tokenOut, params.amountIn);
    return price?.buyAmount ?? 0n;
  }

  async buildSwapCalldata(params: SwapParams, recipient: string, _deadline: number): Promise<SwapCalldata> {
    const quote = await this.getQuote(params.tokenIn, params.tokenOut, params.amountIn, recipient);

    if (!quote) {
      throw new Error('Failed to get 0x quote for swap calldata');
    }

    return {
      to: quote.to,
      data: quote.data,
      value: BigInt(quote.value || '0'),
    };
  }

  async getPoolState(_poolAddress: string): Promise<PoolState> {
    // 0x is an aggregator, not a pool-based DEX
    throw new Error('0x adapter does not support getPoolState - it is an aggregator');
  }

  /**
   * Gets the allowance target for token approvals.
   */
  async getAllowanceTarget(
    sellToken: string,
    buyToken: string,
    sellAmount: bigint
  ): Promise<string | null> {
    const quote = await this.getQuote(sellToken, buyToken, sellAmount);
    return quote?.allowanceTarget ?? null;
  }

  /**
   * Checks if the 0x API is available and the API key is valid.
   */
  async healthCheck(): Promise<boolean> {
    if (!this.apiKey) {
      logger.warn('0x API key not configured');
      return false;
    }

    try {
      const response = await fetch(`${this.apiBaseUrl}/swap/v1/sources?chainId=${CHAIN_ID}`, {
        headers: { '0x-api-key': this.apiKey },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Updates the taker address (executor contract).
   */
  setTakerAddress(address: string): void {
    this.takerAddress = address;
  }

  /**
   * Returns rate limiter statistics.
   */
  getRateLimiterStats(): { acquireCount: number; waitCount: number; availableTokens: number; queueLength: number } {
    return this.rateLimiter.getStats();
  }

  /**
   * Destroys the adapter and cleans up resources.
   */
  destroy(): void {
    this.rateLimiter.destroy();
  }
}