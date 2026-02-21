/**
 * @file ProviderManager.ts
 * @description Manages multiple RPC provider connections. Initializes both primary and fallback
 *              providers. Exposes a single provider interface used throughout the bot.
 *              Routes calls to the primary provider and falls back to the backup on timeout or error.
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { type Config } from '../config';
import { WebSocketProviderManager } from './WebSocketProvider';
import { FallbackProviderManager } from './FallbackProvider';
import { BlockListener, type BlockInfo } from './BlockListener';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('ProviderManager');

export class ProviderManager extends EventEmitter {
  private config: Config;
  private fallbackManager: FallbackProviderManager;
  private wsManager: WebSocketProviderManager;
  private blockListener: BlockListener;
  private signer: ethers.Wallet | null;
  private initialized: boolean;

  constructor(config: Config) {
    super();
    this.config = config;
    this.initialized = false;
    this.signer = null;

    // Initialize HTTP fallback providers
    this.fallbackManager = new FallbackProviderManager(
      [config.rpcUrlPrimary, config.rpcUrlFallback],
      60000, // 60s recovery window
      3 // 3 failures before fallback
    );

    // Initialize WebSocket provider
    this.wsManager = new WebSocketProviderManager(config.rpcUrlWs);

    // Initialize block listener with the primary HTTP provider
    this.blockListener = new BlockListener(this.fallbackManager.getProvider());
  }

  /**
   * Initializes all providers and starts the block listener.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('Initializing provider manager');

    // Verify primary provider connectivity
    try {
      const provider = this.fallbackManager.getProvider();
      const network = await provider.getNetwork();
      const blockNumber = await provider.getBlockNumber();

      logger.info('Primary provider connected', {
        chainId: Number(network.chainId),
        blockNumber,
      });

      if (Number(network.chainId) !== 8453) {
        throw new Error(`Expected Base mainnet (8453), got chain ID ${network.chainId}`);
      }
    } catch (error) {
      logger.error('Primary provider connection failed', { error: (error as Error).message });
      throw error;
    }

    // Initialize signer
    if (this.config.privateKey) {
      this.signer = new ethers.Wallet(
        this.config.privateKey.startsWith('0x') ? this.config.privateKey : `0x${this.config.privateKey}`,
        this.fallbackManager.getProvider()
      );
      logger.info('Signer initialized', { address: this.signer.address });
    }

    // Connect WebSocket (non-blocking)
    this.wsManager.connect().catch((error) => {
      logger.warn('WebSocket connection failed, using HTTP polling', {
        error: (error as Error).message,
      });
    });

    // Set up WebSocket reconnection handler
    this.wsManager.on('reconnected', (wsProvider: ethers.WebSocketProvider) => {
      logger.info('WebSocket reconnected, updating block listener');
      this.blockListener.updateProvider(wsProvider);
    });

    // Forward block events
    this.blockListener.on('newBlock', (blockInfo: BlockInfo) => {
      this.emit('newBlock', blockInfo);
    });

    // Start block listener
    await this.blockListener.start();

    this.initialized = true;
    logger.info('Provider manager initialized');
  }

  /**
   * Returns the primary HTTP JSON-RPC provider.
   */
  getProvider(): ethers.JsonRpcProvider {
    return this.fallbackManager.getProvider();
  }

  /**
   * Returns the fallback provider manager for direct access.
   */
  getFallbackManager(): FallbackProviderManager {
    return this.fallbackManager;
  }

  /**
   * Returns the WebSocket provider if connected, otherwise null.
   */
  getWsProvider(): ethers.WebSocketProvider | null {
    return this.wsManager.getProvider();
  }

  /**
   * Returns the signer (wallet) for transaction signing.
   */
  getSigner(): ethers.Wallet {
    if (!this.signer) {
      throw new Error('Signer not initialized. Ensure PRIVATE_KEY is configured.');
    }
    return this.signer;
  }

  /**
   * Returns the block listener instance.
   */
  getBlockListener(): BlockListener {
    return this.blockListener;
  }

  /**
   * Executes a provider call with automatic fallback.
   */
  async call<T>(fn: (provider: ethers.JsonRpcProvider) => Promise<T>): Promise<T> {
    return this.fallbackManager.execute(fn);
  }

  /**
   * Returns the current block number.
   */
  async getBlockNumber(): Promise<number> {
    return this.fallbackManager.execute((p) => p.getBlockNumber());
  }

  /**
   * Returns the ETH balance of an address.
   */
  async getBalance(address: string): Promise<bigint> {
    return this.fallbackManager.execute((p) => p.getBalance(address));
  }

  /**
   * Returns provider status information.
   */
  getStatus(): {
    providers: Array<{ url: string; isHealthy: boolean; failureCount: number; isActive: boolean }>;
    wsConnected: boolean;
    blockListener: ReturnType<BlockListener['getStats']>;
    signerAddress: string | null;
  } {
    return {
      providers: this.fallbackManager.getStatus(),
      wsConnected: this.wsManager.isConnected(),
      blockListener: this.blockListener.getStats(),
      signerAddress: this.signer?.address || null,
    };
  }

  /**
   * Gracefully shuts down all providers.
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down provider manager');

    this.blockListener.stop();
    await this.wsManager.destroy();
    await this.fallbackManager.destroy();

    this.removeAllListeners();
    this.initialized = false;

    logger.info('Provider manager shut down');
  }
}