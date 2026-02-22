/**
 * @file ChainlinkOracle.ts
 * @description Interfaces with Chainlink price feed contracts on Base using Multicall3 batching.
 *              Batches latestRoundData() calls to avoid rate-limiting on public RPCs.
 *              Falls back gracefully when feeds are unavailable.
 */

import { ethers } from 'ethers';
import { MULTICALL3 } from '../config/addresses';
import { withRetry } from '../utils/retry';
import { createModuleLogger } from '../utils/logger';
import type { OraclePrice } from './types';

const logger = createModuleLogger('ChainlinkOracle');

// Minimal ABI for Chainlink aggregator
const AGGREGATOR_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
];

// Multicall3 ABI
const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)',
];

// Pre-encoded function selectors
const LATEST_ROUND_DATA_SELECTOR = '0xfeaf968c'; // latestRoundData()
const DECIMALS_SELECTOR = '0x313ce567';           // decimals()

// Known decimals for Chainlink feeds (all Base feeds use 8 decimals)
const KNOWN_FEED_DECIMALS: Record<string, number> = {};

export class ChainlinkOracle {
  private provider: ethers.Provider;
  private maxStalenessSeconds: number;
  private multicall: ethers.Contract;
  private aggregatorIface: ethers.Interface;

  constructor(provider: ethers.Provider, maxStalenessSeconds: number = 86400) {
    this.provider = provider;
    this.maxStalenessSeconds = maxStalenessSeconds;
    this.multicall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
    this.aggregatorIface = new ethers.Interface(AGGREGATOR_ABI);
  }

  /**
   * Gets the latest price from a single Chainlink price feed.
   * Uses Multicall3 to batch latestRoundData + decimals into one RPC call.
   */
  async getLatestPrice(feedAddress: string): Promise<OraclePrice> {
    const prices = await this.getBatchPrices([feedAddress]);
    const result = prices.get(feedAddress.toLowerCase());
    if (!result) {
      throw new Error(`Failed to fetch price for feed ${feedAddress}`);
    }
    return result;
  }

  /**
   * Gets prices for multiple feeds in a single Multicall3 batch.
   * Each feed requires 2 calls: latestRoundData() + decimals().
   * Returns a map of feedAddress (lowercase) -> OraclePrice.
   */
  async getBatchPrices(feedAddresses: string[]): Promise<Map<string, OraclePrice>> {
    const results = new Map<string, OraclePrice>();
    if (feedAddresses.length === 0) return results;

    // Build multicall: 2 calls per feed (latestRoundData + decimals)
    const calls = feedAddresses.flatMap((addr) => [
      { target: addr, allowFailure: true, callData: LATEST_ROUND_DATA_SELECTOR },
      { target: addr, allowFailure: true, callData: DECIMALS_SELECTOR },
    ]);

    let returnData: Array<{ success: boolean; returnData: string }>;

    try {
      returnData = await withRetry(
        () => this.multicall.aggregate3.staticCall(calls),
        {
          maxAttempts: 3,
          baseDelayMs: 500,
          retryableErrors: ['TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR'],
        }
      );
    } catch (error) {
      logger.warn('Multicall3 batch failed for oracle feeds', {
        feedCount: feedAddresses.length,
        error: (error as Error).message.slice(0, 80),
      });
      return results;
    }

    const now = Math.floor(Date.now() / 1000);

    for (let i = 0; i < feedAddresses.length; i++) {
      const feedAddr = feedAddresses[i];
      const rdResult  = returnData[i * 2];
      const decResult = returnData[i * 2 + 1];

      if (!rdResult.success || !decResult.success) {
        logger.debug('Feed call failed in multicall', { feedAddr });
        continue;
      }

      try {
        // Decode latestRoundData
        const decoded = this.aggregatorIface.decodeFunctionResult(
          'latestRoundData',
          rdResult.returnData
        );
        const roundId        = decoded[0] as bigint;
        const answer         = decoded[1] as bigint;
        const updatedAt      = Number(decoded[3]);
        const answeredInRound = decoded[4] as bigint;

        // Decode decimals
        const decDecoded = this.aggregatorIface.decodeFunctionResult(
          'decimals',
          decResult.returnData
        );
        const feedDecimals = Number(decDecoded[0]);

        // Cache decimals
        KNOWN_FEED_DECIMALS[feedAddr.toLowerCase()] = feedDecimals;

        // Validate
        if (answer <= 0n) {
          logger.debug('Feed returned non-positive answer', { feedAddr, answer: answer.toString() });
          continue;
        }

        const isStale = (now - updatedAt) > this.maxStalenessSeconds;
        if (isStale) {
          logger.warn('Chainlink price is stale', {
            feedAddress: feedAddr,
            updatedAt,
            ageSeconds: now - updatedAt,
            maxStaleness: this.maxStalenessSeconds,
          });
        }

        const normalizedPrice = this._normalizeToE18(answer, feedDecimals);

        results.set(feedAddr.toLowerCase(), {
          price: normalizedPrice,
          decimals: feedDecimals,
          rawAnswer: answer,
          updatedAt,
          roundId,
          isStale,
        });
      } catch (decodeError) {
        logger.debug('Failed to decode feed result', {
          feedAddr,
          error: (decodeError as Error).message.slice(0, 60),
        });
      }
    }

    return results;
  }

  /**
   * Gets the price as a simple number (USD).
   */
  async getPriceUsd(feedAddress: string): Promise<number> {
    const oraclePrice = await this.getLatestPrice(feedAddress);
    return Number(oraclePrice.rawAnswer) / Math.pow(10, oraclePrice.decimals);
  }

  /**
   * Normalizes a Chainlink answer to 18 decimal precision.
   */
  private _normalizeToE18(answer: bigint, feedDecimals: number): bigint {
    if (feedDecimals === 18) return answer;
    if (feedDecimals < 18) {
      return answer * (10n ** BigInt(18 - feedDecimals));
    }
    return answer / (10n ** BigInt(feedDecimals - 18));
  }

  /**
   * Updates the provider reference.
   */
  updateProvider(provider: ethers.Provider): void {
    this.provider = provider;
    this.multicall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
  }

  /**
   * Updates the max staleness threshold.
   */
  updateMaxStaleness(seconds: number): void {
    this.maxStalenessSeconds = seconds;
  }
}