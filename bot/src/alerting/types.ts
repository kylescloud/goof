/**
 * @file alerting/types.ts
 * @description Type definitions for the alerting module.
 */

export enum AlertLevel {
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
}

export interface Alert {
  level: AlertLevel;
  title: string;
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export interface AlertThrottleConfig {
  maxAlertsPerMinute: number;
  cooldownMs: number;
}