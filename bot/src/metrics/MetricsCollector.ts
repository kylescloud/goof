/**
 * @file MetricsCollector.ts
 * @description Collects and aggregates metrics from all bot modules. Provides a centralized
 *              metrics store that can be queried by the Prometheus exporter.
 */

import { createModuleLogger } from '../utils/logger';
import type { BotMetrics } from './types';

const logger = createModuleLogger('MetricsCollector');

export class MetricsCollector {
  private metrics: BotMetrics;
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
    this.metrics = {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      totalProfitUsd: 0,
      totalGasCostUsd: 0,
      strategyCycleCount: 0,
      opportunitiesFound: 0,
      opportunitiesSimulated: 0,
      opportunitiesProfitable: 0,
      uptime: 0,
      lastBlockNumber: 0,
      lastBlockTimestamp: 0,
      providerErrors: 0,
      totalPools: 0,
      lastDiscoveryTime: 0,
    };
  }

  // ─── Execution Metrics ──────────────────────────────────────────────

  recordExecution(success: boolean, profitUsd: number, gasCostUsd: number): void {
    this.metrics.totalExecutions++;
    if (success) {
      this.metrics.successfulExecutions++;
      this.metrics.totalProfitUsd += profitUsd;
    } else {
      this.metrics.failedExecutions++;
    }
    this.metrics.totalGasCostUsd += gasCostUsd;
  }

  // ─── Strategy Metrics ───────────────────────────────────────────────

  recordStrategyCycle(opportunitiesFound: number): void {
    this.metrics.strategyCycleCount++;
    this.metrics.opportunitiesFound += opportunitiesFound;
  }

  recordSimulation(simulated: number, profitable: number): void {
    this.metrics.opportunitiesSimulated += simulated;
    this.metrics.opportunitiesProfitable += profitable;
  }

  // ─── Block Metrics ──────────────────────────────────────────────────

  recordBlock(blockNumber: number, timestamp: number): void {
    this.metrics.lastBlockNumber = blockNumber;
    this.metrics.lastBlockTimestamp = timestamp;
  }

  // ─── Provider Metrics ───────────────────────────────────────────────

  recordProviderError(): void {
    this.metrics.providerErrors++;
  }

  // ─── Discovery Metrics ──────────────────────────────────────────────

  recordDiscovery(totalPools: number): void {
    this.metrics.totalPools = totalPools;
    this.metrics.lastDiscoveryTime = Date.now();
  }

  // ─── Getters ────────────────────────────────────────────────────────

  getMetrics(): BotMetrics {
    this.metrics.uptime = Date.now() - this.startTime;
    return { ...this.metrics };
  }

  getUptime(): number {
    return Date.now() - this.startTime;
  }

  getSuccessRate(): number {
    if (this.metrics.totalExecutions === 0) return 0;
    return this.metrics.successfulExecutions / this.metrics.totalExecutions;
  }

  getNetProfitUsd(): number {
    return this.metrics.totalProfitUsd - this.metrics.totalGasCostUsd;
  }

  /**
   * Returns a summary string for logging.
   */
  getSummary(): string {
    const m = this.getMetrics();
    const uptimeHours = (m.uptime / 3600000).toFixed(1);
    const successRate = this.getSuccessRate() * 100;
    const netProfit = this.getNetProfitUsd();

    return [
      `Uptime: ${uptimeHours}h`,
      `Executions: ${m.totalExecutions} (${successRate.toFixed(1)}% success)`,
      `Net Profit: $${netProfit.toFixed(2)}`,
      `Pools: ${m.totalPools}`,
      `Block: ${m.lastBlockNumber}`,
      `Cycles: ${m.strategyCycleCount}`,
    ].join(' | ');
  }

  /**
   * Resets all metrics.
   */
  reset(): void {
    this.startTime = Date.now();
    this.metrics = {
      totalExecutions: 0,
      successfulExecutions: 0,
      failedExecutions: 0,
      totalProfitUsd: 0,
      totalGasCostUsd: 0,
      strategyCycleCount: 0,
      opportunitiesFound: 0,
      opportunitiesSimulated: 0,
      opportunitiesProfitable: 0,
      uptime: 0,
      lastBlockNumber: 0,
      lastBlockTimestamp: 0,
      providerErrors: 0,
      totalPools: 0,
      lastDiscoveryTime: 0,
    };
    logger.info('Metrics reset');
  }
}