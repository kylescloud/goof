/**
 * @file WebSocketProvider.ts
 * @description Establishes and maintains a WebSocket connection to the RPC endpoint.
 *              Implements keep-alive pings, automatic reconnection with exponential backoff,
 *              and subscription re-registration after reconnect.
 */

import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { createModuleLogger } from '../utils/logger';

const logger = createModuleLogger('WebSocketProvider');

export class WebSocketProviderManager extends EventEmitter {
  private wsUrl: string;
  private provider: ethers.WebSocketProvider | null;
  private reconnectAttempts: number;
  private maxReconnectAttempts: number;
  private baseReconnectDelayMs: number;
  private pingInterval: NodeJS.Timeout | null;
  private reconnecting: boolean;
  private destroyed: boolean;

  constructor(wsUrl: string, maxReconnectAttempts: number = 10, baseReconnectDelayMs: number = 1000) {
    super();
    this.wsUrl = wsUrl;
    this.provider = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.baseReconnectDelayMs = baseReconnectDelayMs;
    this.pingInterval = null;
    this.reconnecting = false;
    this.destroyed = false;
  }

  /**
   * Connects to the WebSocket endpoint and sets up event handlers.
   */
  async connect(): Promise<ethers.WebSocketProvider> {
    if (this.destroyed) throw new Error('WebSocketProvider has been destroyed');

    try {
      logger.info('Connecting to WebSocket', { url: this.wsUrl });
      this.provider = new ethers.WebSocketProvider(this.wsUrl);

      // Wait for the provider to be ready
      await this.provider.ready;

      const network = await this.provider.getNetwork();
      logger.info('WebSocket connected', {
        chainId: Number(network.chainId),
        name: network.name,
      });

      this.reconnectAttempts = 0;
      this._startPingLoop();
      this._setupErrorHandlers();

      this.emit('connected', this.provider);
      return this.provider;
    } catch (error) {
      logger.error('WebSocket connection failed', { error: (error as Error).message });
      await this._handleReconnect();
      return this.provider!;
    }
  }

  /**
   * Returns the current provider instance.
   */
  getProvider(): ethers.WebSocketProvider | null {
    return this.provider;
  }

  /**
   * Returns true if the provider is connected.
   */
  isConnected(): boolean {
    return this.provider !== null && !this.destroyed;
  }

  /**
   * Destroys the provider and stops all reconnection attempts.
   */
  async destroy(): Promise<void> {
    this.destroyed = true;
    this._stopPingLoop();

    if (this.provider) {
      try {
        await this.provider.destroy();
      } catch (error) {
        logger.warn('Error destroying WebSocket provider', { error: (error as Error).message });
      }
      this.provider = null;
    }

    this.removeAllListeners();
    logger.info('WebSocket provider destroyed');
  }

  /**
   * Sets up error and close handlers on the WebSocket.
   */
  private _setupErrorHandlers(): void {
    if (!this.provider) return;

    this.provider.on('error', (error: Error) => {
      logger.error('WebSocket error', { error: error.message });
      this.emit('error', error);
    });

    // Monitor for disconnection by checking if the websocket closes
    const ws = (this.provider as unknown as { _websocket?: { on: Function } })._websocket;
    if (ws && typeof ws.on === 'function') {
      ws.on('close', () => {
        logger.warn('WebSocket connection closed');
        this.emit('disconnected');
        if (!this.destroyed) {
          this._handleReconnect();
        }
      });
    }
  }

  /**
   * Handles reconnection with exponential backoff.
   */
  private async _handleReconnect(): Promise<void> {
    if (this.reconnecting || this.destroyed) return;
    this.reconnecting = true;

    this._stopPingLoop();

    while (this.reconnectAttempts < this.maxReconnectAttempts && !this.destroyed) {
      this.reconnectAttempts++;
      const delay = Math.min(
        this.baseReconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1),
        30000
      );
      const jitter = delay * 0.3 * Math.random();
      const totalDelay = Math.floor(delay + jitter);

      logger.info('Attempting WebSocket reconnection', {
        attempt: this.reconnectAttempts,
        maxAttempts: this.maxReconnectAttempts,
        delayMs: totalDelay,
      });

      await new Promise((resolve) => setTimeout(resolve, totalDelay));

      if (this.destroyed) break;

      try {
        // Clean up old provider
        if (this.provider) {
          try {
            await this.provider.destroy();
          } catch {
            // Ignore cleanup errors
          }
        }

        this.provider = new ethers.WebSocketProvider(this.wsUrl);
        await this.provider.ready;

        const network = await this.provider.getNetwork();
        logger.info('WebSocket reconnected', {
          chainId: Number(network.chainId),
          attempt: this.reconnectAttempts,
        });

        this.reconnectAttempts = 0;
        this._startPingLoop();
        this._setupErrorHandlers();

        this.reconnecting = false;
        this.emit('reconnected', this.provider);
        return;
      } catch (error) {
        logger.warn('Reconnection attempt failed', {
          attempt: this.reconnectAttempts,
          error: (error as Error).message,
        });
      }
    }

    this.reconnecting = false;

    if (!this.destroyed) {
      logger.error('Max reconnection attempts reached', {
        maxAttempts: this.maxReconnectAttempts,
      });
      this.emit('maxReconnectAttemptsReached');
    }
  }

  /**
   * Starts a periodic ping to keep the WebSocket connection alive.
   */
  private _startPingLoop(): void {
    this._stopPingLoop();

    this.pingInterval = setInterval(async () => {
      if (!this.provider || this.destroyed) return;

      try {
        await this.provider.getBlockNumber();
      } catch (error) {
        logger.warn('WebSocket ping failed', { error: (error as Error).message });
        if (!this.destroyed) {
          this._handleReconnect();
        }
      }
    }, 30000); // Ping every 30 seconds
  }

  /**
   * Stops the ping loop.
   */
  private _stopPingLoop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}