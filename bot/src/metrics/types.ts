/**
 * @file metrics/types.ts
 * @description Type definitions for the metrics module.
 */

export interface BotMetrics {
  // Execution metrics
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  totalProfitUsd: number;
  totalGasCostUsd: number;

  // Strategy metrics
  strategyCycleCount: number;
  opportunitiesFound: number;
  opportunitiesSimulated: number;
  opportunitiesProfitable: number;

  // System metrics
  uptime: number;
  lastBlockNumber: number;
  lastBlockTimestamp: number;
  providerErrors: number;

  // Pool metrics
  totalPools: number;
  lastDiscoveryTime: number;
}