/**
 * @file PrometheusExporter.ts
 * @description Exposes bot metrics via a Prometheus-compatible HTTP endpoint.
 *              Uses prom-client to register gauges, counters, and histograms.
 */

import http from 'http';
import client from 'prom-client';
import { createModuleLogger } from '../utils/logger';
import type { MetricsCollector } from './MetricsCollector';

const logger = createModuleLogger('PrometheusExporter');

export class PrometheusExporter {
  private collector: MetricsCollector;
  private server: http.Server | null;
  private port: number;
  private register: client.Registry;

  // Gauges
  private uptimeGauge: client.Gauge;
  private lastBlockGauge: client.Gauge;
  private totalPoolsGauge: client.Gauge;
  private netProfitGauge: client.Gauge;

  // Counters
  private executionsCounter: client.Counter;
  private successCounter: client.Counter;
  private failureCounter: client.Counter;
  private strategyCyclesCounter: client.Counter;
  private opportunitiesFoundCounter: client.Counter;
  private opportunitiesProfitableCounter: client.Counter;
  private providerErrorsCounter: client.Counter;

  // Histograms
  private profitHistogram: client.Histogram;
  private gasCostHistogram: client.Histogram;

  constructor(collector: MetricsCollector, port: number = 9090) {
    this.collector = collector;
    this.server = null;
    this.port = port;
    this.register = new client.Registry();

    // Set default labels
    this.register.setDefaultLabels({ app: 'arb-bot', chain: 'base' });

    // Register default metrics (process CPU, memory, etc.)
    client.collectDefaultMetrics({ register: this.register });

    // Initialize custom metrics
    this.uptimeGauge = new client.Gauge({
      name: 'arb_bot_uptime_seconds',
      help: 'Bot uptime in seconds',
      registers: [this.register],
    });

    this.lastBlockGauge = new client.Gauge({
      name: 'arb_bot_last_block_number',
      help: 'Last processed block number',
      registers: [this.register],
    });

    this.totalPoolsGauge = new client.Gauge({
      name: 'arb_bot_total_pools',
      help: 'Total number of indexed pools',
      registers: [this.register],
    });

    this.netProfitGauge = new client.Gauge({
      name: 'arb_bot_net_profit_usd',
      help: 'Total net profit in USD',
      registers: [this.register],
    });

    this.executionsCounter = new client.Counter({
      name: 'arb_bot_executions_total',
      help: 'Total number of execution attempts',
      registers: [this.register],
    });

    this.successCounter = new client.Counter({
      name: 'arb_bot_executions_success_total',
      help: 'Total number of successful executions',
      registers: [this.register],
    });

    this.failureCounter = new client.Counter({
      name: 'arb_bot_executions_failure_total',
      help: 'Total number of failed executions',
      registers: [this.register],
    });

    this.strategyCyclesCounter = new client.Counter({
      name: 'arb_bot_strategy_cycles_total',
      help: 'Total number of strategy cycles run',
      registers: [this.register],
    });

    this.opportunitiesFoundCounter = new client.Counter({
      name: 'arb_bot_opportunities_found_total',
      help: 'Total number of opportunities found',
      registers: [this.register],
    });

    this.opportunitiesProfitableCounter = new client.Counter({
      name: 'arb_bot_opportunities_profitable_total',
      help: 'Total number of profitable opportunities after simulation',
      registers: [this.register],
    });

    this.providerErrorsCounter = new client.Counter({
      name: 'arb_bot_provider_errors_total',
      help: 'Total number of RPC provider errors',
      registers: [this.register],
    });

    this.profitHistogram = new client.Histogram({
      name: 'arb_bot_profit_usd',
      help: 'Distribution of profit per execution in USD',
      buckets: [0.1, 0.5, 1, 5, 10, 25, 50, 100, 250, 500, 1000],
      registers: [this.register],
    });

    this.gasCostHistogram = new client.Histogram({
      name: 'arb_bot_gas_cost_usd',
      help: 'Distribution of gas cost per execution in USD',
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.register],
    });
  }

  /**
   * Starts the Prometheus HTTP server.
   */
  async start(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      if (req.url === '/metrics') {
        this._updateMetrics();
        res.setHeader('Content-Type', this.register.contentType);
        res.end(await this.register.metrics());
      } else if (req.url === '/health') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', uptime: this.collector.getUptime() }));
      } else {
        res.statusCode = 404;
        res.end('Not Found');
      }
    });

    return new Promise((resolve) => {
      this.server!.listen(this.port, () => {
        logger.info('Prometheus exporter started', { port: this.port });
        resolve();
      });
    });
  }

  /**
   * Stops the Prometheus HTTP server.
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          logger.info('Prometheus exporter stopped');
          resolve();
        });
      });
    }
  }

  /**
   * Records an execution for histogram tracking.
   */
  recordExecution(profitUsd: number, gasCostUsd: number, success: boolean): void {
    if (success) {
      this.profitHistogram.observe(profitUsd);
    }
    this.gasCostHistogram.observe(gasCostUsd);
  }

  /**
   * Updates all gauge metrics from the collector.
   */
  private _updateMetrics(): void {
    const m = this.collector.getMetrics();

    this.uptimeGauge.set(m.uptime / 1000);
    this.lastBlockGauge.set(m.lastBlockNumber);
    this.totalPoolsGauge.set(m.totalPools);
    this.netProfitGauge.set(this.collector.getNetProfitUsd());

    // Sync counters (counters only go up, so we set to current total)
    this._syncCounter(this.executionsCounter, m.totalExecutions);
    this._syncCounter(this.successCounter, m.successfulExecutions);
    this._syncCounter(this.failureCounter, m.failedExecutions);
    this._syncCounter(this.strategyCyclesCounter, m.strategyCycleCount);
    this._syncCounter(this.opportunitiesFoundCounter, m.opportunitiesFound);
    this._syncCounter(this.opportunitiesProfitableCounter, m.opportunitiesProfitable);
    this._syncCounter(this.providerErrorsCounter, m.providerErrors);
  }

  /**
   * Syncs a counter to a target value by incrementing the difference.
   */
  private _syncCounter(counter: client.Counter, targetValue: number): void {
    // prom-client counters don't support setting directly, so we track internally
    // For simplicity, we reset and re-increment (this works for our use case)
    const currentValue = (counter as unknown as { hashMap: Record<string, { value: number }> }).hashMap?.['']?.value ?? 0;
    const diff = targetValue - currentValue;
    if (diff > 0) {
      counter.inc(diff);
    }
  }
}