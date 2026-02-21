/**
 * @file AlertManager.ts
 * @description Central alert dispatcher. Routes alerts to Telegram and logs. Implements
 *              throttling to prevent alert storms. Provides convenience methods for common
 *              alert types (execution success, failure, circuit breaker, etc.).
 */

import { TelegramNotifier } from './TelegramNotifier';
import { createModuleLogger } from '../utils/logger';
import { AlertLevel, type Alert } from './types';
import type { ExecutionResult } from '../execution/types';
import type { SimulationResult } from '../simulation/types';

const logger = createModuleLogger('AlertManager');

export class AlertManager {
  private telegram: TelegramNotifier;
  private throttleMap: Map<string, number>;
  private throttleCooldownMs: number;

  constructor(telegramBotToken: string, telegramChatId: string, throttleCooldownMs: number = 60000) {
    this.telegram = new TelegramNotifier(telegramBotToken, telegramChatId);
    this.throttleMap = new Map();
    this.throttleCooldownMs = throttleCooldownMs;
  }

  /**
   * Sends a generic alert.
   */
  async sendAlert(alert: Alert): Promise<void> {
    // Log the alert
    const logFn = alert.level === AlertLevel.ERROR || alert.level === AlertLevel.CRITICAL
      ? logger.error.bind(logger)
      : alert.level === AlertLevel.WARNING
        ? logger.warn.bind(logger)
        : logger.info.bind(logger);

    logFn(alert.title, { level: alert.level, message: alert.message, ...alert.data });

    // Check throttle
    if (this._isThrottled(alert.title)) return;

    // Send to Telegram
    await this.telegram.sendAlert(alert);
  }

  /**
   * Alerts on successful arbitrage execution.
   */
  async alertExecutionSuccess(result: ExecutionResult): Promise<void> {
    await this.sendAlert({
      level: AlertLevel.INFO,
      title: '✅ Arbitrage Executed',
      message: [
        `Profit: $${result.profitUsd.toFixed(2)}`,
        `Gas Cost: $${result.gasCostUsd.toFixed(2)}`,
        `TX: ${result.txHash}`,
        `Block: ${result.blockNumber}`,
        `Time: ${result.executionTimeMs}ms`,
      ].join('\n'),
      timestamp: Date.now(),
      data: {
        txHash: result.txHash,
        profitUsd: result.profitUsd,
        gasCostUsd: result.gasCostUsd,
        gasUsed: result.gasUsed.toString(),
      },
    });
  }

  /**
   * Alerts on failed arbitrage execution.
   */
  async alertExecutionFailure(result: ExecutionResult): Promise<void> {
    await this.sendAlert({
      level: AlertLevel.WARNING,
      title: '❌ Execution Failed',
      message: [
        `Reason: ${result.failureReason || 'Unknown'}`,
        `TX: ${result.txHash || 'Not submitted'}`,
        `Error: ${result.error || 'None'}`,
      ].join('\n'),
      timestamp: Date.now(),
      data: {
        failureReason: result.failureReason,
        error: result.error,
      },
    });
  }

  /**
   * Alerts when the circuit breaker trips.
   */
  async alertCircuitBreakerTripped(data: { consecutiveFailures: number; cooldownMs: number; reason: string }): Promise<void> {
    await this.sendAlert({
      level: AlertLevel.CRITICAL,
      title: '🚨 Circuit Breaker TRIPPED',
      message: [
        `Consecutive Failures: ${data.consecutiveFailures}`,
        `Cooldown: ${data.cooldownMs / 1000}s`,
        `Reason: ${data.reason}`,
        'Bot execution is paused.',
      ].join('\n'),
      timestamp: Date.now(),
      data,
    });
  }

  /**
   * Alerts on profitable opportunity found.
   */
  async alertOpportunityFound(simulation: SimulationResult): Promise<void> {
    await this.sendAlert({
      level: AlertLevel.INFO,
      title: '💰 Profitable Opportunity',
      message: [
        `Strategy: ${simulation.path.strategy}`,
        `Net Profit: $${simulation.netProfitUsd.toFixed(2)}`,
        `Flash Amount: ${simulation.path.flashAmount.toString()}`,
        `Hops: ${simulation.path.hops}`,
      ].join('\n'),
      timestamp: Date.now(),
      data: {
        strategy: simulation.path.strategy,
        netProfitUsd: simulation.netProfitUsd,
        hops: simulation.path.hops,
      },
    });
  }

  /**
   * Alerts on bot startup.
   */
  async alertBotStarted(info: { address: string; balance: string; pools: number }): Promise<void> {
    await this.sendAlert({
      level: AlertLevel.INFO,
      title: '🚀 Arbitrage Bot Started',
      message: [
        `Executor: ${info.address}`,
        `Balance: ${info.balance} ETH`,
        `Pools: ${info.pools}`,
        `Time: ${new Date().toISOString()}`,
      ].join('\n'),
      timestamp: Date.now(),
      data: info,
    });
  }

  /**
   * Alerts on bot shutdown.
   */
  async alertBotStopped(reason: string): Promise<void> {
    await this.sendAlert({
      level: AlertLevel.WARNING,
      title: '🛑 Arbitrage Bot Stopped',
      message: `Reason: ${reason}`,
      timestamp: Date.now(),
    });
  }

  /**
   * Alerts on low wallet balance.
   */
  async alertLowBalance(balanceEth: number, minReserveEth: number): Promise<void> {
    await this.sendAlert({
      level: AlertLevel.CRITICAL,
      title: '⚠️ Low Wallet Balance',
      message: [
        `Current: ${balanceEth.toFixed(6)} ETH`,
        `Minimum: ${minReserveEth.toFixed(6)} ETH`,
        'Please fund the wallet.',
      ].join('\n'),
      timestamp: Date.now(),
      data: { balanceEth, minReserveEth },
    });
  }

  /**
   * Checks if an alert type is currently throttled.
   */
  private _isThrottled(key: string): boolean {
    const lastSent = this.throttleMap.get(key);
    if (lastSent && Date.now() - lastSent < this.throttleCooldownMs) {
      return true;
    }
    this.throttleMap.set(key, Date.now());
    return false;
  }
}