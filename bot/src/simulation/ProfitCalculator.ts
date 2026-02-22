/**
 * @file ProfitCalculator.ts
 * @description Calculates net profit after accounting for flash loan premium, gas costs,
 *              and slippage buffer. Converts all values to USD for comparison.
 */

import { FLASH_LOAN_PREMIUM_BPS, FLASH_LOAN_PREMIUM_DIVISOR } from '../config/constants';
import { OracleRegistry } from '../oracle/OracleRegistry';
import { fromBigInt } from '../utils/bigIntMath';
import { TOKEN_BY_ADDRESS } from '../config/addresses';
import { createModuleLogger } from '../utils/logger';
import type { GasEstimate } from './types';

const logger = createModuleLogger('ProfitCalculator');

export interface ProfitBreakdown {
  grossProfitToken: bigint;
  grossProfitUsd: number;
  flashLoanPremium: bigint;
  flashLoanPremiumUsd: number;
  gasCostUsd: number;
  slippageCostUsd: number;
  netProfitToken: bigint;
  netProfitUsd: number;
  isProfitable: boolean;
  roi: number;
}

export class ProfitCalculator {
  private oracleRegistry: OracleRegistry;
  private slippageBufferBps: number;

  constructor(oracleRegistry: OracleRegistry, slippageBufferBps: number = 50) {
    this.oracleRegistry = oracleRegistry;
    this.slippageBufferBps = slippageBufferBps;
  }

  /**
   * Calculates the full profit breakdown for an arbitrage opportunity.
   * @param flashAsset The flash loan asset address.
   * @param flashAmount The flash loan amount.
   * @param returnAmount The expected return amount after all swaps.
   * @param gasEstimate The gas cost estimate.
   * @returns The profit breakdown.
   */
  async calculateProfit(
    flashAsset: string,
    flashAmount: bigint,
    returnAmount: bigint,
    gasEstimate: GasEstimate
  ): Promise<ProfitBreakdown> {
    const tokenInfo = TOKEN_BY_ADDRESS[flashAsset.toLowerCase()];
    const decimals = tokenInfo?.decimals ?? 18;

    // Flash loan premium
    const premium = (flashAmount * FLASH_LOAN_PREMIUM_BPS) / FLASH_LOAN_PREMIUM_DIVISOR;
    const totalRepayment = flashAmount + premium;

    // Gross profit in token terms
    const grossProfitToken = returnAmount > totalRepayment ? returnAmount - totalRepayment : 0n;

    // Get token price in USD
    // OracleRegistry always returns a value (stablecoin=$1, ETH=$2000 fallback)
    let tokenPriceUsd = 1.0;
    try {
      const priceData = await this.oracleRegistry.getTokenPriceUSD(flashAsset);
      if (priceData.priceUsd > 0 && priceData.priceUsd < 1_000_000) {
        tokenPriceUsd = priceData.priceUsd;
      } else {
        logger.warn('Token price out of reasonable range, using $1 fallback', {
          flashAsset,
          priceUsd: priceData.priceUsd,
        });
      }
    } catch {
      logger.warn('Failed to get token price, using $1 fallback', { flashAsset });
    }

    const grossProfitUsd = fromBigInt(grossProfitToken, decimals) * tokenPriceUsd;
    const flashLoanPremiumUsd = fromBigInt(premium, decimals) * tokenPriceUsd;

    // Slippage cost estimate
    const slippageCostUsd = grossProfitUsd * (this.slippageBufferBps / 10000);

    // Net profit
    const netProfitUsd = grossProfitUsd - gasEstimate.gasCostUsd - slippageCostUsd;

    // Net profit in token terms (approximate)
    const netProfitToken = tokenPriceUsd > 0
      ? BigInt(Math.floor(netProfitUsd / tokenPriceUsd * (10 ** decimals)))
      : 0n;

    // ROI
    const flashAmountUsd = fromBigInt(flashAmount, decimals) * tokenPriceUsd;
    const roi = flashAmountUsd > 0 ? (netProfitUsd / flashAmountUsd) * 100 : 0;

    const isProfitable = netProfitUsd > 0;

    return {
      grossProfitToken,
      grossProfitUsd,
      flashLoanPremium: premium,
      flashLoanPremiumUsd,
      gasCostUsd: gasEstimate.gasCostUsd,
      slippageCostUsd,
      netProfitToken,
      netProfitUsd,
      isProfitable,
      roi,
    };
  }

  /**
   * Calculates the minimum return amount needed for profitability.
   * @param flashAmount The flash loan amount.
   * @param gasEstimate The gas cost estimate.
   * @param flashAsset The flash asset address.
   * @returns The minimum return amount.
   */
  async calculateMinReturn(
    flashAmount: bigint,
    gasEstimate: GasEstimate,
    flashAsset: string
  ): Promise<bigint> {
    const tokenInfo = TOKEN_BY_ADDRESS[flashAsset.toLowerCase()];
    const decimals = tokenInfo?.decimals ?? 18;

    // Flash loan premium
    const premium = (flashAmount * FLASH_LOAN_PREMIUM_BPS) / FLASH_LOAN_PREMIUM_DIVISOR;

    // Convert gas cost to token amount
    let tokenPriceUsd = 1.0;
    try {
      const priceData = await this.oracleRegistry.getTokenPriceUSD(flashAsset);
      if (priceData.priceUsd > 0 && priceData.priceUsd < 1_000_000) {
        tokenPriceUsd = priceData.priceUsd;
      }
    } catch { /* use default */ }

    const gasCostInTokens = tokenPriceUsd > 0
      ? BigInt(Math.ceil(gasEstimate.gasCostUsd / tokenPriceUsd * (10 ** decimals)))
      : 0n;

    // Add slippage buffer
    const slippageBuffer = (flashAmount * BigInt(this.slippageBufferBps)) / 10000n;

    return flashAmount + premium + gasCostInTokens + slippageBuffer;
  }

  /**
   * Updates the slippage buffer.
   */
  setSlippageBuffer(bps: number): void {
    this.slippageBufferBps = bps;
  }
}