/**
 * @file ExecutionEngine.ts
 * @description Full execution orchestrator. Receives profitable simulation results, checks circuit
 *              breaker, builds transactions, manages nonces, submits transactions, watches for
 *              confirmations, classifies failures, and emits execution results.
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { type Config } from '../config';
import { TOKENS } from '../config/addresses';
import { NonceManager } from './NonceManager';
import { GasPriceManager } from './GasPriceManager';
import { CircuitBreaker } from './CircuitBreaker';
import { TransactionBuilder } from './TransactionBuilder';
import { OracleRegistry } from '../oracle/OracleRegistry';
import { fromBigInt } from '../utils/bigIntMath';
import { createModuleLogger } from '../utils/logger';
import type { SimulationResult } from '../simulation/types';
import type { ExecutionResult, FailureCategory } from './types';

const logger = createModuleLogger('ExecutionEngine');

export class ExecutionEngine extends EventEmitter {
  private config: Config;
  private signer: ethers.Wallet;
  private provider: ethers.Provider;
  private nonceManager: NonceManager;
  private gasPriceManager: GasPriceManager;
  private circuitBreaker: CircuitBreaker;
  private txBuilder: TransactionBuilder;
  private oracleRegistry: OracleRegistry;
  private executing: boolean;
  private executionCount: number;
  private successCount: number;
  private failureCount: number;
  private totalProfitUsd: number;

  constructor(
    config: Config,
    signer: ethers.Wallet,
    provider: ethers.Provider,
    oracleRegistry: OracleRegistry
  ) {
    super();
    this.config = config;
    this.signer = signer;
    this.provider = provider;
    this.oracleRegistry = oracleRegistry;
    this.executing = false;
    this.executionCount = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.totalProfitUsd = 0;

    this.nonceManager = new NonceManager(provider, signer.address);
    this.gasPriceManager = new GasPriceManager(provider, config.maxGasPriceGwei, config.priorityFeeGwei);
    this.circuitBreaker = new CircuitBreaker(config.maxConsecutiveFailures, config.circuitBreakerCooldownMs);
    this.txBuilder = new TransactionBuilder(config.arbitrageExecutorAddress);

    // Forward circuit breaker events
    this.circuitBreaker.on('tripped', (data) => this.emit('circuitBreakerTripped', data));
    this.circuitBreaker.on('closed', () => this.emit('circuitBreakerClosed'));
  }

  /**
   * Initializes the execution engine.
   */
  async initialize(): Promise<void> {
    await this.nonceManager.initialize();

    // Verify wallet balance
    const balance = await this.provider.getBalance(this.signer.address);
    const balanceEth = fromBigInt(balance, 18);
    logger.info('Execution engine initialized', {
      executor: this.signer.address,
      balanceEth: balanceEth.toFixed(6),
    });

    if (balance < this.config.minEthReserveWei) {
      logger.warn('Wallet balance below minimum reserve', {
        balance: balanceEth.toFixed(6),
        minReserve: fromBigInt(this.config.minEthReserveWei, 18).toFixed(6),
      });
    }
  }

  /**
   * Executes the best profitable opportunity from simulation results.
   * @param simulations Array of profitable simulation results, sorted by profit.
   * @returns The execution result, or null if no execution was attempted.
   */
  async execute(simulations: SimulationResult[]): Promise<ExecutionResult | null> {
    if (simulations.length === 0) return null;
    if (this.executing) {
      logger.warn('Execution already in progress, skipping');
      return null;
    }

    // Check circuit breaker
    if (!this.circuitBreaker.canExecute()) {
      logger.warn('Circuit breaker is open, skipping execution');
      return null;
    }

    // Check gas price
    const gasPriceOk = await this.gasPriceManager.isGasPriceAcceptable();
    if (!gasPriceOk) {
      logger.warn('Gas price too high, skipping execution');
      return null;
    }

    // Check wallet balance
    const balance = await this.provider.getBalance(this.signer.address);
    if (balance < this.config.minEthReserveWei) {
      logger.error('Insufficient ETH balance for gas', {
        balance: fromBigInt(balance, 18).toFixed(6),
      });
      return null;
    }

    // Take the best opportunity
    const bestSim = simulations[0];
    this.executing = true;
    this.executionCount++;

    const startTime = Date.now();
    let nonce = -1;

    try {
      // Get gas price
      const gasData = await this.gasPriceManager.getGasPrice();

      // Get nonce
      nonce = await this.nonceManager.getNextNonce();

      // Build transaction
      const deadline = Math.floor(Date.now() / 1000) + 120; // 2 minute deadline
      const gasLimit = bestSim.gasEstimate * 12n / 10n; // 20% buffer

      const txRequest = this.txBuilder.buildTransaction(
        bestSim, nonce, gasData.maxFeePerGas, gasData.maxPriorityFeePerGas, gasLimit, deadline
      );

      logger.info('Submitting arbitrage transaction', {
        flashAsset: bestSim.path.flashAsset,
        flashAmount: bestSim.path.flashAmount.toString(),
        expectedProfitUsd: bestSim.netProfitUsd.toFixed(2),
        gasLimit: gasLimit.toString(),
        nonce,
      });

      // Sign and send
      const tx = await this.signer.sendTransaction({
        to: txRequest.to,
        data: txRequest.data,
        value: txRequest.value,
        gasLimit: txRequest.gasLimit,
        maxFeePerGas: txRequest.maxFeePerGas,
        maxPriorityFeePerGas: txRequest.maxPriorityFeePerGas,
        nonce: txRequest.nonce,
        type: 2,
        chainId: txRequest.chainId,
      });

      logger.info('Transaction submitted', { txHash: tx.hash, nonce });

      // Wait for confirmation
      const receipt = await tx.wait(1);

      if (!receipt) {
        throw new Error('Transaction receipt is null');
      }

      if (receipt.status === 1) {
        // Success
        this.nonceManager.confirmNonce(nonce);
        this.circuitBreaker.recordSuccess();
        this.successCount++;

        const gasUsed = receipt.gasUsed;
        const gasCostWei = gasUsed * receipt.gasPrice;
        const ethPrice = await this._getEthPrice();
        const gasCostUsd = fromBigInt(gasCostWei, 18) * ethPrice;

        const result: ExecutionResult = {
          success: true,
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          gasUsed,
          gasCostUsd,
          profit: bestSim.simulatedProfit,
          profitUsd: bestSim.netProfitUsd - gasCostUsd + (bestSim.gasCostUsd ?? 0),
          executionTimeMs: Date.now() - startTime,
          simulationResult: bestSim,
        };

        this.totalProfitUsd += result.profitUsd;

        logger.info('Arbitrage executed successfully!', {
          txHash: result.txHash,
          profitUsd: result.profitUsd.toFixed(2),
          gasUsed: gasUsed.toString(),
          gasCostUsd: gasCostUsd.toFixed(4),
          executionTimeMs: result.executionTimeMs,
        });

        this.emit('executionSuccess', result);
        return result;
      } else {
        // Reverted
        throw new Error('Transaction reverted');
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const failureCategory = this._classifyFailure(err);

      if (nonce >= 0) {
        if (failureCategory === 'NONCE_TOO_LOW') {
          await this.nonceManager.sync();
        } else {
          this.nonceManager.releaseNonce(nonce);
        }
      }

      this.circuitBreaker.recordFailure(failureCategory);
      this.failureCount++;

      const result: ExecutionResult = {
        success: false,
        txHash: '',
        blockNumber: 0,
        gasUsed: 0n,
        gasCostUsd: 0,
        profit: 0n,
        profitUsd: 0,
        executionTimeMs: Date.now() - startTime,
        simulationResult: bestSim,
        error: err.message,
        failureReason: failureCategory,
      };

      logger.error('Arbitrage execution failed', {
        error: err.message,
        failureCategory,
        executionTimeMs: result.executionTimeMs,
      });

      this.emit('executionFailure', result);
      return result;
    } finally {
      this.executing = false;
    }
  }

  /**
   * Classifies a transaction failure into a category.
   */
  private _classifyFailure(error: Error): FailureCategory {
    const msg = error.message.toLowerCase();

    if (msg.includes('nonce') && msg.includes('too low')) return 'NONCE_TOO_LOW' as FailureCategory;
    if (msg.includes('insufficient funds')) return 'INSUFFICIENT_FUNDS' as FailureCategory;
    if (msg.includes('out of gas') || msg.includes('gas required exceeds')) return 'OUT_OF_GAS' as FailureCategory;
    if (msg.includes('timeout') || msg.includes('timed out')) return 'TIMEOUT' as FailureCategory;
    if (msg.includes('network') || msg.includes('connection')) return 'NETWORK_ERROR' as FailureCategory;
    if (msg.includes('slippage') || msg.includes('minamount')) return 'SLIPPAGE' as FailureCategory;
    if (msg.includes('revert') || msg.includes('execution reverted')) return 'REVERT' as FailureCategory;

    return 'UNKNOWN' as FailureCategory;
  }

  private async _getEthPrice(): Promise<number> {
    try {
      const price = await this.oracleRegistry.getTokenPriceUSD(TOKENS.WETH.address);
      return price.priceUsd;
    } catch { return 3000; }
  }

  getStats(): { executionCount: number; successCount: number; failureCount: number; totalProfitUsd: number; circuitBreaker: ReturnType<CircuitBreaker['getState']> } {
    return {
      executionCount: this.executionCount,
      successCount: this.successCount,
      failureCount: this.failureCount,
      totalProfitUsd: this.totalProfitUsd,
      circuitBreaker: this.circuitBreaker.getState(),
    };
  }
}