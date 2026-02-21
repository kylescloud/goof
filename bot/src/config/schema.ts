/**
 * @file schema.ts
 * @description Zod schema definition for all configurable parameters. Validates environment
 *              variables and exports a typed Config object.
 */

import { z } from 'zod';

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');

export const configSchema = z.object({
  // --- RPC Providers ---
  rpcUrlPrimary: z.string().url('RPC_URL_PRIMARY must be a valid URL'),
  rpcUrlFallback: z.string().url('RPC_URL_FALLBACK must be a valid URL'),
  rpcUrlWs: z.string().min(1, 'RPC_URL_WS is required'),

  // --- Wallet ---
  privateKey: z.string().min(64, 'PRIVATE_KEY must be at least 64 characters (hex without 0x prefix)'),

  // --- Deployed Contract ---
  arbitrageExecutorAddress: addressSchema,

  // --- Profit & Gas ---
  minProfitThresholdUsd: z.number().min(0).default(10),
  maxGasPriceGwei: z.number().min(0).default(50),
  priorityFeeGwei: z.number().min(0).default(0.1),
  minEthReserveWei: z.bigint().default(10000000000000000n),
  slippageBufferBps: z.number().int().min(0).max(1000).default(50),

  // --- 0x Protocol API ---
  zeroXApiKey: z.string().default(''),
  zeroXApiBaseUrl: z.string().url().default('https://api.0x.org'),
  zeroXRateLimitRps: z.number().int().min(1).default(5),

  // --- Telegram Alerts ---
  telegramBotToken: z.string().default(''),
  telegramChatId: z.string().default(''),

  // --- Prometheus Metrics ---
  prometheusPort: z.number().int().min(1024).max(65535).default(9090),

  // --- Discovery ---
  discoveryCron: z.string().default('*/5 * * * *'),
  discoveryBatchSize: z.number().int().min(1).default(200),
  discoveryBlockRange: z.number().int().min(100).default(10000),

  // --- Path Generation ---
  beamWidth: z.number().int().min(1).default(20),
  maxHops: z.number().int().min(2).max(6).default(4),
  minPoolLiquidityUsd: z.number().min(0).default(10000),

  // --- Simulation ---
  simulationWorkers: z.number().int().min(1).max(16).default(4),
  confirmationTimeoutMs: z.number().int().min(5000).default(60000),

  // --- Circuit Breaker ---
  maxConsecutiveFailures: z.number().int().min(1).default(5),
  circuitBreakerCooldownMs: z.number().int().min(10000).default(300000),

  // --- Oracle ---
  maxOracleStalenessSeconds: z.number().int().min(60).default(3600),
  priceCacheTtlMs: z.number().int().min(1000).default(30000),

  // --- Logging ---
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // --- Strategy-Specific ---
  v2v3DivergenceThresholdBps: z.number().int().min(1).default(30),
  wethCircuitBreakerPct: z.number().min(0.1).default(2),
  stableDepegThresholdBps: z.number().int().min(1).default(10),
});

export type Config = z.infer<typeof configSchema>;