// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { NodeId } from '../core/Config';

/** Supported logging severity levels in ascending order. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured key-value logging context payload. */
export interface LogContext {
  [key: string]: unknown;
}

/** Logging contract used across raft-core components. */
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  toggle(): void;
}

/**
 * Console-backed logger with minimum level filtering.
 */
export class ConsoleLogger implements Logger {
  private static readonly levels: LogLevel[] = ['debug', 'info', 'warn', 'error']; // static => class level,

  constructor(
    private readonly nodeId: NodeId,
    private readonly minDebugLevel: LogLevel = 'info',
    private enabled: boolean = true,
  ) {}

  /** Logs a debug message when min level allows it. */
  debug(message: string, context?: LogContext): void {
    if (this.enabled) {
      this.printMessage(message, 'debug', context);
    }
  }

  /** Logs an informational message when min level allows it. */
  info(message: string, context?: LogContext): void {
    if (this.enabled) {
      this.printMessage(message, 'info', context);
    }
  }

  /** Logs a warning message when min level allows it. */
  warn(message: string, context?: LogContext): void {
    if (this.enabled) {
      this.printMessage(message, 'warn', context);
    }
  }

  /** Logs an error message when min level allows it. */
  error(message: string, context?: LogContext): void {
    // Always want to see errors!
    this.printMessage(message, 'error', context);
  }

  /** Allows for disabling the logger to not always clog up the console */
  toggle(): void {
    this.enabled = !this.enabled;
  }

  /** Formats and emits one log line to console. */
  private printMessage(message: string, logLevel: LogLevel, context?: LogContext): void {
    if (this.shouldLog(logLevel)) {
      const timestamp = new Date().toISOString();
      const ctx = context ? `${JSON.stringify(context)}` : '';

      const toPrintMsg = `[${logLevel.toUpperCase()}] [${timestamp}] [${this.nodeId}] ${message} ${ctx}`;
      console.log(toPrintMsg);
    }
  }

  /** Returns true when a log level is at or above configured minimum level. */
  private shouldLog(logLevel: LogLevel): boolean {
    const lowIdx = ConsoleLogger.levels.indexOf(this.minDebugLevel);
    const currIdx = ConsoleLogger.levels.indexOf(logLevel);

    return currIdx >= lowIdx;
  }
}

/*
const MyLogger = new ConsoleLogger('node 5', 'info');

MyLogger.debug("this is a debug message");
MyLogger.info("this is an info message", { someKey: "someValue" });
MyLogger.warn("this is a warning message");
MyLogger.error("this is an error message", { errorCode: 123 });
*/
