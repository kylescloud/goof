/**
 * @file TelegramNotifier.ts
 * @description Sends alert messages to a Telegram chat via the Telegram Bot API.
 *              Implements rate limiting and message formatting.
 */

import { createModuleLogger } from '../utils/logger';
import type { Alert, AlertLevel } from './types';

const logger = createModuleLogger('TelegramNotifier');

const LEVEL_EMOJI: Record<string, string> = {
  INFO: 'ℹ️',
  WARNING: '⚠️',
  ERROR: '❌',
  CRITICAL: '🚨',
};

export class TelegramNotifier {
  private botToken: string;
  private chatId: string;
  private enabled: boolean;
  private messageCount: number;
  private lastResetTime: number;
  private maxMessagesPerMinute: number;

  constructor(botToken: string, chatId: string, maxMessagesPerMinute: number = 10) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.enabled = botToken.length > 0 && chatId.length > 0;
    this.messageCount = 0;
    this.lastResetTime = Date.now();
    this.maxMessagesPerMinute = maxMessagesPerMinute;

    if (this.enabled) {
      logger.info('Telegram notifier enabled', { chatId });
    } else {
      logger.info('Telegram notifier disabled (no bot token or chat ID)');
    }
  }

  /**
   * Sends an alert to Telegram.
   * @param alert The alert to send.
   */
  async sendAlert(alert: Alert): Promise<void> {
    if (!this.enabled) return;

    // Rate limiting
    if (!this._checkRateLimit()) {
      logger.debug('Telegram rate limit reached, dropping alert', { title: alert.title });
      return;
    }

    const message = this._formatMessage(alert);

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'Unknown error');
        logger.warn('Telegram send failed', { status: response.status, error: errorBody });
      } else {
        this.messageCount++;
      }
    } catch (error) {
      logger.warn('Telegram notification error', { error: (error as Error).message });
    }
  }

  /**
   * Sends a raw text message to Telegram.
   */
  async sendMessage(text: string): Promise<void> {
    if (!this.enabled) return;
    if (!this._checkRateLimit()) return;

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      this.messageCount++;
    } catch (error) {
      logger.warn('Telegram message error', { error: (error as Error).message });
    }
  }

  /**
   * Formats an alert into a Telegram message.
   */
  private _formatMessage(alert: Alert): string {
    const emoji = LEVEL_EMOJI[alert.level] || '📋';
    const timestamp = new Date(alert.timestamp).toISOString();

    let message = `${emoji} <b>${alert.title}</b>\n`;
    message += `<i>${timestamp}</i>\n\n`;
    message += alert.message;

    if (alert.data && Object.keys(alert.data).length > 0) {
      message += '\n\n<b>Details:</b>\n';
      for (const [key, value] of Object.entries(alert.data)) {
        message += `• <code>${key}</code>: ${String(value)}\n`;
      }
    }

    // Telegram message limit is 4096 characters
    if (message.length > 4000) {
      message = message.substring(0, 3997) + '...';
    }

    return message;
  }

  /**
   * Checks if we're within the rate limit.
   */
  private _checkRateLimit(): boolean {
    const now = Date.now();
    if (now - this.lastResetTime > 60000) {
      this.messageCount = 0;
      this.lastResetTime = now;
    }
    return this.messageCount < this.maxMessagesPerMinute;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}