/**
 * @file index.ts
 * @description Main entry point for the Base Arbitrage Bot. Initializes all modules,
 *              wires the event-driven pipeline, and runs the main event loop:
 *              BlockListener → StrategyEngine → SimulationEngine → ExecutionEngine
 *              Handles graceful shutdown on SIGINT/SIGTERM.
 */

import { ethers } from 'ethers';
import { getConfig, type Config } from './config';
import { ProviderManager } from './providers/ProviderManager';
import { DiscoveryEngine } from './discovery/DiscoveryEngine';
import { TokenGraph } from './graph/TokenGraph';
import { DexAdapterRegistry } from './dex/DexAdapterRegistry';
import { OracleRegistry } from './oracle/OracleRegistry';
import { StrategyEngine } from './strategies/StrategyEngine';
import { SimulationEngine } from './simulation/SimulationEngine';
import { ExecutionEngine } from './execution/ExecutionEngine';
import { AlertManager } from './alerting/AlertManager';
import { MetricsCollector } from './metrics/MetricsCollector';
import { PrometheusExporter } from './metrics/PrometheusExporter';
import { ZeroXAdapter } from './dex/adapters/ZeroXAdapter';
import { createModuleLogger } from './utils/logger';
import type { BlockInfo } from './providers/BlockListener';
import type { SimulationResult } from './simulation/types';
import type { ExecutionResult } from './execution/types';

const logger = createModuleLogger('Main');

// ─── Global State ───────────────────────────────────────────────────────
let isShuttingDown = false;
let providerManager: ProviderManager;
let discoveryEngine: DiscoveryEngine;
let strategyEngine: StrategyEngine;
let simulationEngine: SimulationEngine;
let executionEngine: ExecutionEngine;
let alertManager: AlertManager;
let metricsCollector: MetricsCollector;
let prometheusExporter: PrometheusExporter;
let oracleRegistryGlobal: OracleRegistry; // global ref for prefetch in cycle

// ─── Main Bootstrap ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('=== Base Arbitrage Bot Starting ===');
  logger.info('Chain: Base (8453)');
  logger.info('PID: ' + process.pid);

  // 1. Load and validate configuration
  const config = getConfig();
  logger.info('Configuration loaded and validated');

  // 2. Initialize Provider Manager
  providerManager = new ProviderManager(config);
  await providerManager.initialize();
  const provider = providerManager.getProvider();
  const signer = providerManager.getSigner();

  if (!signer) {
    throw new Error('Signer not initialized. Check PRIVATE_KEY in .env');
  }

  logger.info('Provider and signer initialized', { executor: signer.address });

  // 3. Initialize Metrics
  metricsCollector = new MetricsCollector();
  prometheusExporter = new PrometheusExporter(metricsCollector, config.prometheusPort);
  await prometheusExporter.start();
  logger.info('Metrics exporter started', { port: config.prometheusPort });

  // 4. Initialize Alert Manager
  alertManager = new AlertManager(config.telegramBotToken, config.telegramChatId);

  // 5. Initialize Oracle Registry
  const oracleRegistry = new OracleRegistry(
    provider,
    config.maxOracleStalenessSeconds,
    config.priceCacheTtlMs
  );
  oracleRegistryGlobal = oracleRegistry;
  // Pre-warm oracle cache on startup
  await oracleRegistry.prefetchAllPrices().catch((e) =>
    logger.warn('Oracle prefetch on startup failed', { error: (e as Error).message })
  );
  logger.info('Oracle registry initialized');

  // 6. Initialize DEX Adapter Registry
  const dexRegistry = new DexAdapterRegistry();
  dexRegistry.initialize(provider);
  logger.info('DEX adapter registry initialized');

  // 7. Initialize 0x Adapter (if configured)
  let zeroXAdapter: ZeroXAdapter | undefined;
  if (config.zeroXApiKey) {
    zeroXAdapter = new ZeroXAdapter(
      provider,
      config.zeroXApiKey,
      config.zeroXApiBaseUrl,
      config.zeroXRateLimitRps,
      signer.address
    );
    logger.info('0x adapter initialized');
  }

  // 8. Initialize Discovery Engine and run initial discovery
  discoveryEngine = new DiscoveryEngine(config, provider);
  await discoveryEngine.initialize();
  const registry = discoveryEngine.getRegistry();
  logger.info('Discovery engine initialized', { totalPools: registry.meta.totalPools });
  metricsCollector.recordDiscovery(registry.meta.totalPools);

  // 9. Build Token Graph
  const tokenGraph = new TokenGraph();
  tokenGraph.buildFromRegistry(registry);
  logger.info('Token graph built', {
    tokens: tokenGraph.getTokenCount(),
    edges: tokenGraph.getEdgeCount(),
  });

  // 10. Initialize Strategy Engine
  strategyEngine = new StrategyEngine(
    config, registry, tokenGraph, dexRegistry, oracleRegistry, zeroXAdapter
  );

  // 11. Initialize Simulation Engine
  simulationEngine = new SimulationEngine(config, provider, oracleRegistry);

  // 12. Initialize Execution Engine
  executionEngine = new ExecutionEngine(config, signer, provider, oracleRegistry);
  await executionEngine.initialize();

  // ─── Wire Event Pipeline ────────────────────────────────────────────

  // Discovery → Graph update
  discoveryEngine.on('poolsUpdated', (updatedRegistry) => {
    tokenGraph.buildFromRegistry(updatedRegistry);
    strategyEngine.updateRegistry(updatedRegistry);
    metricsCollector.recordDiscovery(updatedRegistry.meta.totalPools);
    logger.info('Graph updated after discovery', {
      tokens: tokenGraph.getTokenCount(),
      edges: tokenGraph.getEdgeCount(),
    });
  });

  // Block → Strategy cycle
  providerManager.on('newBlock', async (blockInfo: BlockInfo) => {
    if (isShuttingDown) return;

    metricsCollector.recordBlock(blockInfo.number, blockInfo.timestamp);

    try {
      await runArbitrageCycle(blockInfo, config);
    } catch (error) {
      logger.error('Arbitrage cycle error', {
        block: blockInfo.number,
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
      metricsCollector.recordProviderError();
    }
  });

  // Execution events → Alerts & Metrics
  executionEngine.on('executionSuccess', async (result: ExecutionResult) => {
    metricsCollector.recordExecution(true, result.profitUsd, result.gasCostUsd);
    prometheusExporter.recordExecution(result.profitUsd, result.gasCostUsd, true);
    await alertManager.alertExecutionSuccess(result);
  });

  executionEngine.on('executionFailure', async (result: ExecutionResult) => {
    metricsCollector.recordExecution(false, 0, result.gasCostUsd);
    prometheusExporter.recordExecution(0, result.gasCostUsd, false);
    await alertManager.alertExecutionFailure(result);
  });

  executionEngine.on('circuitBreakerTripped', async (data: { consecutiveFailures: number; cooldownMs: number; reason: string }) => {
    await alertManager.alertCircuitBreakerTripped(data);
  });

  // ─── Startup Complete ───────────────────────────────────────────────

  const balance = await providerManager.getProvider().getBalance(signer.address);
  await alertManager.alertBotStarted({
    address: signer.address,
    balance: ethers.formatEther(balance),
    pools: registry.meta.totalPools,
  });

  logger.info('=== Base Arbitrage Bot Running ===');
  logger.info(`Executor: ${signer.address}`);
  logger.info(`Contract: ${config.arbitrageExecutorAddress}`);
  logger.info(`Pools: ${registry.meta.totalPools}`);
  logger.info(`Tokens: ${tokenGraph.getTokenCount()}`);
  logger.info(`Strategies: 7 active`);
  logger.info(`Min Profit: $${config.minProfitThresholdUsd}`);
  logger.info(`Max Gas: ${config.maxGasPriceGwei} gwei`);

  // Periodic metrics logging
  setInterval(() => {
    logger.info('Bot status', { summary: metricsCollector.getSummary() });
  }, 60000);
}

// ─── Arbitrage Cycle ────────────────────────────────────────────────────

async function runArbitrageCycle(blockInfo: BlockInfo, config: Config): Promise<void> {
  const cycleStart = Date.now();

  // 0. Prefetch oracle prices (batched Multicall3 — no-op if cache is fresh)
  await oracleRegistryGlobal.prefetchAllPrices().catch(() => {/* non-fatal */});

  // 1. Run all strategies
  const candidates = await strategyEngine.runCycle();
  metricsCollector.recordStrategyCycle(candidates.length);

  if (candidates.length === 0) {
    logger.debug('No opportunities found', { block: blockInfo.number });
    return;
  }

  logger.info('Opportunities found', {
    block: blockInfo.number,
    candidates: candidates.length,
  });

  // 2. Simulate top candidates
  const topCandidates = candidates.slice(0, 10); // Simulate top 10
  const profitable = await simulationEngine.simulateBatch(topCandidates);
  metricsCollector.recordSimulation(topCandidates.length, profitable.length);

  if (profitable.length === 0) {
    logger.debug('No profitable opportunities after simulation', { block: blockInfo.number });
    return;
  }

  logger.info('Profitable opportunities', {
    block: blockInfo.number,
    profitable: profitable.length,
    bestProfitUsd: profitable[0].netProfitUsd.toFixed(2),
  });

  // 3. Execute the best opportunity
  const result = await executionEngine.execute(profitable);

  if (result) {
    const cycleDuration = Date.now() - cycleStart;
    logger.info('Arbitrage cycle complete', {
      block: blockInfo.number,
      success: result.success,
      profitUsd: result.profitUsd.toFixed(2),
      cycleDurationMs: cycleDuration,
    });
  }
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal}, shutting down gracefully...`);

  try {
    // Stop accepting new blocks
    if (discoveryEngine) discoveryEngine.stop();

    // Stop metrics server
    if (prometheusExporter) await prometheusExporter.stop();

    // Send shutdown alert
    if (alertManager) await alertManager.alertBotStopped('Graceful shutdown');

    // Destroy providers
    if (providerManager) await providerManager.shutdown();

    logger.info('Shutdown complete');
  } catch (error) {
    logger.error('Error during shutdown', { error: (error as Error).message });
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

// ─── Start ──────────────────────────────────────────────────────────────

main().catch((error) => {
  logger.error('Fatal error during startup', { error: error.message, stack: error.stack });
  process.exit(1);
});