/**
 * @file CircuitBreaker.ts
 * @description Tracks consecutive execution failures. After maxConsecutiveFailures, opens the
 *              circuit breaker and pauses execution for a cooldown period. Resets on success.
 */

import { EventEmitter } from 'events';
import { createModuleLogger } from '../utils/logger';
import type { CircuitBreakerState } from './types';

const logger = createModuleLogger('CircuitBreaker');

export class CircuitBreaker extends EventEmitter {
  private maxConsecutiveFailures: number;
  private cooldownMs: number;
  private state: CircuitBreakerState;

  constructor(maxConsecutiveFailures: number = 5, cooldownMs: number = 300000) {
    super();
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.cooldownMs = cooldownMs;
    this.state = {
      isOpen: false,
      consecutiveFailures: 0,
      lastFailureTime: 0,
      cooldownUntil: 0,
      totalFailures: 0,
      totalSuccesses: 0,
    };
  }

  /**
   * Checks if execution is allowed (circuit is closed or cooldown has elapsed).
   * @returns True if execution is allowed.
   */
  canExecute(): boolean {
    if (!this.state.isOpen) return true;

    // Check if cooldown has elapsed
    if (Date.now() >= this.state.cooldownUntil) {
      this._halfOpen();
      return true;
    }

    const remainingMs = this.state.cooldownUntil - Date.now();
    logger.debug('Circuit breaker is open', { remainingMs });
    return false;
  }

  /**
   * Records a successful execution. Resets the failure counter and closes the circuit.
   */
  recordSuccess(): void {
    this.state.totalSuccesses++;
    this.state.consecutiveFailures = 0;

    if (this.state.isOpen) {
      this.state.isOpen = false;
      logger.info('Circuit breaker closed after success', {
        totalSuccesses: this.state.totalSuccesses,
        totalFailures: this.state.totalFailures,
      });
      this.emit('closed');
    }
  }

  /**
   * Records a failed execution. Increments the failure counter and potentially opens the circuit.
   * @param reason The failure reason.
   */
  recordFailure(reason: string): void {
    this.state.totalFailures++;
    this.state.consecutiveFailures++;
    this.state.lastFailureTime = Date.now();

    logger.warn('Execution failure recorded', {
      consecutiveFailures: this.state.consecutiveFailures,
      maxConsecutiveFailures: this.maxConsecutiveFailures,
      reason,
    });

    if (this.state.consecutiveFailures >= this.maxConsecutiveFailures && !this.state.isOpen) {
      this._trip(reason);
    }
  }

  /**
   * Returns the current circuit breaker state.
   */
  getState(): CircuitBreakerState {
    return { ...this.state };
  }

  /**
   * Manually resets the circuit breaker.
   */
  reset(): void {
    this.state.isOpen = false;
    this.state.consecutiveFailures = 0;
    this.state.cooldownUntil = 0;
    logger.info('Circuit breaker manually reset');
    this.emit('reset');
  }

  /**
   * Trips the circuit breaker (opens it).
   */
  private _trip(reason: string): void {
    this.state.isOpen = true;
    this.state.cooldownUntil = Date.now() + this.cooldownMs;

    logger.error('Circuit breaker TRIPPED', {
      consecutiveFailures: this.state.consecutiveFailures,
      cooldownMs: this.cooldownMs,
      cooldownUntil: new Date(this.state.cooldownUntil).toISOString(),
      reason,
    });

    this.emit('tripped', {
      consecutiveFailures: this.state.consecutiveFailures,
      cooldownMs: this.cooldownMs,
      reason,
    });
  }

  /**
   * Transitions to half-open state (allows one test execution).
   */
  private _halfOpen(): void {
    logger.info('Circuit breaker half-open, allowing test execution');
    this.state.isOpen = false;
    this.state.consecutiveFailures = this.maxConsecutiveFailures - 1; // One more failure will re-trip
    this.emit('halfOpen');
  }
}