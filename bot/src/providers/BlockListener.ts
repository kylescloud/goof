/**
 * @file BlockListener.ts
 * @description Subscribes to newHeads via the WebSocket provider. On each new block,
 *              emits a newBlock event consumed by the StrategyEngine to trigger a simulation cycle.
 *              Tracks block timestamps and detects missed blocks.
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('BlockListener');

export interface BlockInfo {
  number: number;
  timestamp: number;
  baseFeePerGas: bigint | null;
  hash: string;
  parentHash: string;
  gasUsed: bigint;
  gasLimit: bigint;
}

export class BlockListener extends EventEmitter {
  private provider: ethers.Provider;
  private lastBlockNumber: number;
  private lastBlockTimestamp: number;
  private missedBlocks: number;
  private totalBlocks: number;
  private listening: boolean;
  private pollInterval: NodeJS.Timeout | null;
  private pollIntervalMs: number;

  constructor(provider: ethers.Provider, pollIntervalMs: number = 2000) {
    super();
    this.provider = provider;
    this.lastBlockNumber = 0;
    this.lastBlockTimestamp = 0;
    this.missedBlocks = 0;
    this.totalBlocks = 0;
    this.listening = false;
    this.pollInterval = null;
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Starts listening for new blocks.
   */
  async start(): Promise<void> {
    if (this.listening) return;
    this.listening = true;

    // Get initial block
    try {
      const block = await this.provider.getBlock('latest');
      if (block) {
        this.lastBlockNumber = block.number;
        this.lastBlockTimestamp = block.timestamp;
        logger.info('BlockListener started', {
          initialBlock: block.number,
          timestamp: block.timestamp,
        });
      }
    } catch (error) {
      logger.error('Failed to get initial block', { error: (error as Error).message });
    }

    // Try WebSocket subscription first
    try {
      this.provider.on('block', (blockNumber: number) => {
        this._handleNewBlock(blockNumber);
      });
      logger.info('Subscribed to block events via provider');
    } catch (error) {
      logger.warn('Block subscription failed, falling back to polling', {
        error: (error as Error).message,
      });
    }

    // Also start polling as a fallback/supplement
    this._startPolling();
  }

  /**
   * Stops listening for new blocks.
   */
  stop(): void {
    this.listening = false;

    try {
      this.provider.removeAllListeners('block');
    } catch {
      // Ignore
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    logger.info('BlockListener stopped', {
      totalBlocks: this.totalBlocks,
      missedBlocks: this.missedBlocks,
    });
  }

  /**
   * Updates the provider reference (e.g., after reconnection).
   */
  updateProvider(provider: ethers.Provider): void {
    this.stop();
    this.provider = provider;
    if (this.listening) {
      this.start();
    }
  }

  /**
   * Returns block listener statistics.
   */
  getStats(): {
    lastBlockNumber: number;
    lastBlockTimestamp: number;
    missedBlocks: number;
    totalBlocks: number;
    listening: boolean;
  } {
    return {
      lastBlockNumber: this.lastBlockNumber,
      lastBlockTimestamp: this.lastBlockTimestamp,
      missedBlocks: this.missedBlocks,
      totalBlocks: this.totalBlocks,
      listening: this.listening,
    };
  }

  /**
   * Handles a new block number notification.
   */
  private async _handleNewBlock(blockNumber: number): Promise<void> {
    if (!this.listening) return;
    if (blockNumber <= this.lastBlockNumber) return; // Duplicate or old block

    // Detect missed blocks
    if (this.lastBlockNumber > 0 && blockNumber > this.lastBlockNumber + 1) {
      const missed = blockNumber - this.lastBlockNumber - 1;
      this.missedBlocks += missed;
      logger.warn('Missed blocks detected', {
        expected: this.lastBlockNumber + 1,
        received: blockNumber,
        missed,
      });
    }

    this.totalBlocks++;

    try {
      const block = await this.provider.getBlock(blockNumber);
      if (!block) {
        logger.warn('Block data unavailable', { blockNumber });
        this.lastBlockNumber = blockNumber;
        return;
      }

      const blockInfo: BlockInfo = {
        number: block.number,
        timestamp: block.timestamp,
        baseFeePerGas: block.baseFeePerGas,
        hash: block.hash || '',
        parentHash: block.parentHash,
        gasUsed: block.gasUsed,
        gasLimit: block.gasLimit,
      };

      this.lastBlockNumber = blockNumber;
      this.lastBlockTimestamp = block.timestamp;

      logger.debug('New block', {
        number: blockInfo.number,
        baseFee: blockInfo.baseFeePerGas?.toString(),
        gasUsed: blockInfo.gasUsed.toString(),
      });

      this.emit('newBlock', blockInfo);
    } catch (error) {
      logger.error('Error processing new block', {
        blockNumber,
        error: (error as Error).message,
      });
      this.lastBlockNumber = blockNumber;
    }
  }

  /**
   * Starts polling for new blocks as a fallback mechanism.
   */
  private _startPolling(): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(async () => {
      if (!this.listening) return;

      try {
        const currentBlock = await this.provider.getBlockNumber();
        if (currentBlock > this.lastBlockNumber) {
          await this._handleNewBlock(currentBlock);
        }
      } catch (error) {
        logger.debug('Block polling error', { error: (error as Error).message });
      }
    }, this.pollIntervalMs);
  }
}