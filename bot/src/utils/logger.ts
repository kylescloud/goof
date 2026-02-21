/**
 * @file logger.ts
 * @description Configures a winston logger with two transports: a rotating daily file transport
 *              (writing JSON-structured logs to logs/) and a console transport with colorized output.
 *              Exports a singleton logger instance used throughout the application.
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';

const LOG_DIR = path.resolve(__dirname, '../../logs');

const customFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.colorize(),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, module, ...meta }) => {
    const moduleStr = module ? `[${module}]` : '';
    const metaStr = Object.keys(meta).length > 0 && !meta.stack
      ? ` ${JSON.stringify(meta)}`
      : '';
    const stackStr = meta.stack ? `\n${meta.stack}` : '';
    return `${timestamp} ${level} ${moduleStr} ${message}${metaStr}${stackStr}`;
  })
);

const fileRotateTransport = new DailyRotateFile({
  dirname: LOG_DIR,
  filename: 'arb-bot-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '50m',
  maxFiles: '14d',
  format: customFormat,
  level: 'debug',
});

const errorFileTransport = new DailyRotateFile({
  dirname: LOG_DIR,
  filename: 'arb-bot-error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '50m',
  maxFiles: '30d',
  format: customFormat,
  level: 'error',
});

const consoleTransport = new winston.transports.Console({
  format: consoleFormat,
  level: process.env.LOG_LEVEL || 'info',
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  defaultMeta: { service: 'arb-bot' },
  transports: [fileRotateTransport, errorFileTransport, consoleTransport],
  exitOnError: false,
});

/**
 * Creates a child logger with a module name attached to all log entries.
 * @param moduleName The name of the module using this logger.
 * @returns A child logger instance.
 */
export function createModuleLogger(moduleName: string): winston.Logger {
  return logger.child({ module: moduleName });
}

export default logger;