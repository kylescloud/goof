/**
 * @file ChainlinkOracle.ts
 * @description Interfaces with Chainlink price feed contracts on Base.
 *              Reads latestRoundData() from each feed. Validates that the round is not stale.
 *              Converts the raw int256 answer to a normalized USD price as an 18-decimal BigInt.
 */

import { ethers } from 'ethers';
import { CHAINLINK_AGGREGATOR_ABI } from '../config/constants';
import { withRetry } from '../utils/retry';
import { createModuleLogger } from '../utils/logger';
import type { OraclePrice } from './types';

const logger = createModuleLogger('ChainlinkOracle');

export class ChainlinkOracle {
  private provider: ethers.Provider;
  private maxStalenessSeconds: number;

  constructor(provider: ethers.Provider, maxStalenessSeconds: number = 3600) {
    this.provider = provider;
    this.maxStalenessSeconds = maxStalenessSeconds;
  }

  /**
   * Gets the latest price from a Chainlink price feed.
   * @param feedAddress The Chainlink aggregator contract address.
   * @returns The oracle price data.
   */
  async getLatestPrice(feedAddress: string): Promise<OraclePrice> {
    const contract = new ethers.Contract(feedAddress, CHAINLINK_AGGREGATOR_ABI, this.provider);

    const [roundData, feedDecimals] = await withRetry(
      async () => {
        const rd = await contract.latestRoundData();
        const dec = await contract.decimals();
        return [rd, Number(dec)] as const;
      },
      {
        maxAttempts: 3,
        baseDelayMs: 500,
        retryableErrors: ['TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR'],
      }
    );

    const roundId = roundData[0] as bigint;
    const answer = roundData[1] as bigint;
    const updatedAt = Number(roundData[3]);
    const answeredInRound = roundData[4] as bigint;

    // Validate the round data
    if (answer <= 0n) {
      logger.warn('Chainlink returned non-positive price', { feedAddress, answer: answer.toString() });
    }

    if (answeredInRound < roundId) {
      logger.warn('Chainlink answer is from a previous round', {
        feedAddress,
        roundId: roundId.toString(),
        answeredInRound: answeredInRound.toString(),
      });
    }

    // Check staleness
    const now = Math.floor(Date.now() / 1000);
    const isStale = (now - updatedAt) > this.maxStalenessSeconds;

    if (isStale) {
      logger.warn('Chainlink price is stale', {
        feedAddress,
        updatedAt,
        ageSeconds: now - updatedAt,
        maxStaleness: this.maxStalenessSeconds,
      });
    }

    // Normalize to 18 decimals
    const normalizedPrice = this._normalizeToE18(answer, feedDecimals);

    return {
      price: normalizedPrice,
      decimals: feedDecimals,
      rawAnswer: answer,
      updatedAt,
      roundId,
      isStale,
    };
  }

  /**
   * Gets the price as a simple number (USD).
   * @param feedAddress The Chainlink aggregator contract address.
   * @returns The price as a floating-point number.
   */
  async getPriceUsd(feedAddress: string): Promise<number> {
    const oraclePrice = await this.getLatestPrice(feedAddress);
    return Number(oraclePrice.rawAnswer) / Math.pow(10, oraclePrice.decimals);
  }

  /**
   * Normalizes a Chainlink answer to 18 decimal precision.
   * @param answer The raw answer from Chainlink.
   * @param feedDecimals The number of decimals in the feed.
   * @returns The price with 18 decimal precision.
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
  }

  /**
   * Updates the max staleness threshold.
   */
  updateMaxStaleness(seconds: number): void {
    this.maxStalenessSeconds = seconds;
  }
}