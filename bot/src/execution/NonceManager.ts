/**
 * @file NonceManager.ts
 * @description Manages transaction nonces to prevent nonce conflicts. Tracks the latest nonce
 *              locally and syncs with the chain periodically. Handles nonce gaps and resets.
 */

import { ethers } from 'ethers';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('NonceManager');

export class NonceManager {
  private provider: ethers.Provider;
  private address: string;
  private currentNonce: number;
  private pendingNonces: Set<number>;
  private initialized: boolean;
  private mutex: Promise<void>;

  constructor(provider: ethers.Provider, address: string) {
    this.provider = provider;
    this.address = address;
    this.currentNonce = -1;
    this.pendingNonces = new Set();
    this.initialized = false;
    this.mutex = Promise.resolve();
  }

  /**
   * Initializes the nonce manager by fetching the current nonce from the chain.
   */
  async initialize(): Promise<void> {
    const chainNonce = await this.provider.getTransactionCount(this.address, 'latest');
    const pendingNonce = await this.provider.getTransactionCount(this.address, 'pending');
    this.currentNonce = Math.max(chainNonce, pendingNonce);
    this.initialized = true;
    logger.info('Nonce manager initialized', { address: this.address, nonce: this.currentNonce });
  }

  /**
   * Gets the next available nonce. Thread-safe via mutex.
   * @returns The next nonce to use.
   */
  async getNextNonce(): Promise<number> {
    return new Promise<number>((resolve) => {
      this.mutex = this.mutex.then(async () => {
        if (!this.initialized) await this.initialize();

        const nonce = this.currentNonce;
        this.currentNonce++;
        this.pendingNonces.add(nonce);

        logger.debug('Nonce allocated', { nonce, nextNonce: this.currentNonce });
        resolve(nonce);
      });
    });
  }

  /**
   * Confirms a nonce was successfully used (transaction mined).
   * @param nonce The nonce that was confirmed.
   */
  confirmNonce(nonce: number): void {
    this.pendingNonces.delete(nonce);
    logger.debug('Nonce confirmed', { nonce, pending: this.pendingNonces.size });
  }

  /**
   * Releases a nonce that was not used (transaction failed before submission).
   * @param nonce The nonce to release.
   */
  releaseNonce(nonce: number): void {
    this.pendingNonces.delete(nonce);
    // If this was the last allocated nonce, decrement
    if (nonce === this.currentNonce - 1 && !this.pendingNonces.has(nonce)) {
      this.currentNonce = nonce;
    }
    logger.debug('Nonce released', { nonce, currentNonce: this.currentNonce });
  }

  /**
   * Syncs the local nonce with the chain state.
   */
  async sync(): Promise<void> {
    const chainNonce = await this.provider.getTransactionCount(this.address, 'pending');
    if (chainNonce > this.currentNonce) {
      logger.warn('Nonce sync: chain ahead of local', {
        local: this.currentNonce,
        chain: chainNonce,
      });
      this.currentNonce = chainNonce;
    }
    this.pendingNonces.clear();
  }

  /**
   * Resets the nonce manager by re-fetching from chain.
   */
  async reset(): Promise<void> {
    this.pendingNonces.clear();
    this.initialized = false;
    await this.initialize();
    logger.info('Nonce manager reset', { nonce: this.currentNonce });
  }

  /**
   * Returns the current nonce state.
   */
  getState(): { currentNonce: number; pendingCount: number } {
    return { currentNonce: this.currentNonce, pendingCount: this.pendingNonces.size };
  }

  updateProvider(provider: ethers.Provider): void {
    this.provider = provider;
  }
}