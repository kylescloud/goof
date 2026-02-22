/**
 * @file config/index.ts
 * @description Loads .env file using dotenv, parses and validates all environment variables
 *              against the Zod schema. Exports a typed, validated Config object.
 */

import dotenv from 'dotenv';
import path from 'path';
import { configSchema, type Config } from './schema';

// Load .env from the bot directory
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function parseConfig(): Config {
  const raw = {
    rpcUrlPrimary:  process.env.RPC_URL_PRIMARY  || 'https://mainnet.base.org',
    rpcUrlFallback: process.env.RPC_URL_FALLBACK || 'https://base.llamarpc.com',
    rpcUrlWs:       process.env.RPC_URL_WS       || 'wss://base.publicnode.com',

    privateKey: process.env.PRIVATE_KEY || '',

    arbitrageExecutorAddress: process.env.ARBITRAGE_EXECUTOR_ADDRESS || '0x0000000000000000000000000000000000000000',

    // Default 0 = show ALL opportunities for analysis. Set MIN_PROFIT_THRESHOLD_USD=1 in prod.
    minProfitThresholdUsd:  parseFloat(process.env.MIN_PROFIT_THRESHOLD_USD  || '0'),
    maxGasPriceGwei:        parseFloat(process.env.MAX_GAS_PRICE_GWEI        || '50'),
    priorityFeeGwei:        parseFloat(process.env.PRIORITY_FEE_GWEI         || '0.1'),
    minEthReserveWei:       BigInt(process.env.MIN_ETH_RESERVE_WEI           || '10000000000000000'),
    slippageBufferBps:      parseInt(process.env.SLIPPAGE_BUFFER_BPS         || '50', 10),

    zeroXApiKey:        process.env.ZERO_X_API_KEY      || '',
    zeroXApiBaseUrl:    process.env.ZERO_X_API_BASE_URL || 'https://api.0x.org',
    zeroXRateLimitRps:  parseInt(process.env.ZERO_X_RATE_LIMIT_RPS || '5', 10),

    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId:   process.env.TELEGRAM_CHAT_ID   || '',

    prometheusPort: parseInt(process.env.PROMETHEUS_PORT || '9090', 10),

    discoveryCron:       process.env.DISCOVERY_CRON        || '*/5 * * * *',
    discoveryBatchSize:  parseInt(process.env.DISCOVERY_BATCH_SIZE  || '50',    10),
    discoveryBlockRange: parseInt(process.env.DISCOVERY_BLOCK_RANGE || '10000', 10),

    beamWidth:           parseInt(process.env.BEAM_WIDTH            || '20',   10),
    maxHops:             parseInt(process.env.MAX_HOPS              || '4',    10),
    minPoolLiquidityUsd: parseFloat(process.env.MIN_POOL_LIQUIDITY_USD || '1000'),

    simulationWorkers:     parseInt(process.env.SIMULATION_WORKERS      || '4',     10),
    confirmationTimeoutMs: parseInt(process.env.CONFIRMATION_TIMEOUT_MS || '60000', 10),

    maxConsecutiveFailures:   parseInt(process.env.MAX_CONSECUTIVE_FAILURES    || '5',      10),
    circuitBreakerCooldownMs: parseInt(process.env.CIRCUIT_BREAKER_COOLDOWN_MS || '300000', 10),

    maxOracleStalenessSeconds: parseInt(process.env.MAX_ORACLE_STALENESS_SECONDS || '3600',  10),
    priceCacheTtlMs:           parseInt(process.env.PRICE_CACHE_TTL_MS           || '30000', 10),

    logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',

    // Lowered defaults to catch more opportunities for analysis
    v2v3DivergenceThresholdBps: parseInt(process.env.V2V3_DIVERGENCE_THRESHOLD_BPS || '10', 10),
    wethCircuitBreakerPct:      parseFloat(process.env.WETH_CIRCUIT_BREAKER_PCT    || '2'),
    stableDepegThresholdBps:    parseInt(process.env.STABLE_DEPEG_THRESHOLD_BPS    || '5',  10),
  };

  const result = configSchema.safeParse(raw);

  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) => `  ${issue.path.join('.')}: ${issue.message}`
    );
    console.error('Configuration validation failed:');
    console.error(errors.join('\n'));
    throw new Error(`Invalid configuration:\n${errors.join('\n')}`);
  }

  return result.data;
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (!_config) {
    _config = parseConfig();
  }
  return _config;
}

export function resetConfig(): void {
  _config = null;
}

export type { Config };