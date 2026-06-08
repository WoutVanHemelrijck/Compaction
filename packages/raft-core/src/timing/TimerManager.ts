// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { Clock, TimerHandle } from './Clock';
import { Random } from '../util/Random';
import { TimerManagerError } from '../util/Error';
import { Logger } from '../util/Logger';

/**
 * Timing configuration for election and heartbeat scheduling.
 */
export interface TimerConfig {
  /** Minimum election timeout in milliseconds. */
  electionTimeoutMin: number;
  /** Maximum election timeout in milliseconds. */
  electionTimeoutMax: number;
  /** Heartbeat interval in milliseconds. */
  heartbeatInterval: number;
}

/**
 * Timer manager contract for election and heartbeat control.
 */
export interface TimerManagerIInterface {
  startElectionTimer(callback: () => void | Promise<void>): void;
  resetElectionTimer(): void;
  stopElectionTimer(): void;
  isElectionTimerActive(): boolean;
  startHeartbeatTimer(callback: () => void | Promise<void>): void;
  stopHeartbeatTimer(): void;
  isHeartbeatTimerActive(): boolean;
  stopAllTimers(): void;
  getElectionTimeoutRange(): { min: number; max: number };
  getHeartbeatInterval(): number;
}

/**
 * Raft timer coordinator for randomized election timeout and periodic heartbeat loop.
 */
export class TimerManager implements TimerManagerIInterface {
  private electionTimer: TimerHandle | null = null;
  private heartbeatTimer: TimerHandle | null = null;
  private electionCallback: (() => void | Promise<void>) | null = null;
  private heartbeatCallback: (() => void | Promise<void>) | null = null;
  private static readonly minRatio = 2;
  private static readonly maxHeartBeats = Number.MAX_SAFE_INTEGER;
  private heartbeatCount = 0;

  /**
   * Creates a timer manager and validates timing constraints.
   *
   * @param clock Clock abstraction for timer control.
   * @param random Random source used for election timeout jitter.
   * @param logger Logger for callback failures and diagnostics.
   * @param config Election and heartbeat timing configuration.
   * @throws TimerManagerError When configuration is invalid.
   */
  constructor(
    private clock: Clock,
    private random: Random,
    private logger: Logger,
    private config: TimerConfig,
  ) {
    this.validateConfig(config);
  }

  /**
   * Starts or restarts election timeout with randomized delay.
   *
   * @param callback Callback executed when timeout elapses.
   */
  startElectionTimer(callback: () => void | Promise<void>): void {
    this.stopElectionTimer();
    this.electionCallback = callback;

    const timeoutMs = this.getRandomElectionTimeout();

    this.electionTimer = this.clock.setTimeout(() => {
      this.electionTimer = null;
      try {
        const maybePromise = this.electionCallback?.();
        if (maybePromise && typeof maybePromise.then === 'function') {
          void maybePromise.catch((error: unknown) => {
            this.logger.error(`Error in election timer callback`, { error });
          });
        }
      } catch (error) {
        this.logger.error(`Error in election timer callback`, { error });
      }
    }, timeoutMs);
  }

  /** Restarts election timer using the last provided callback. */
  resetElectionTimer(): void {
    if (!this.electionCallback) {
      return;
    }

    this.startElectionTimer(this.electionCallback);
  }

  /** Stops active election timer if present. */
  stopElectionTimer(): void {
    if (this.electionTimer !== null) {
      this.clock.clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }
  }

  /** Returns true when election timer is currently scheduled. */
  isElectionTimerActive(): boolean {
    return this.electionTimer !== null;
  }

  /**
   * Starts heartbeat schedule and stores callback for recurring execution.
   *
   * @param callback Callback executed on each heartbeat tick.
   */
  startHeartbeatTimer(callback: () => void | Promise<void>): void {
    this.stopHeartbeatTimer();
    this.heartbeatCallback = callback;
    this.heartbeatCount = 0;
    this.scheduleNextHeartbeat();
  }

  /** Stops heartbeat scheduling and clears callback reference. */
  stopHeartbeatTimer(): void {
    if (this.heartbeatTimer !== null) {
      this.clock.clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.heartbeatCallback = null;
  }

  /** Returns true when heartbeat timer is currently scheduled. */
  isHeartbeatTimerActive(): boolean {
    return this.heartbeatTimer !== null;
  }

  /** Stops all timers and clears timer callbacks. */
  stopAllTimers(): void {
    this.stopElectionTimer();
    this.stopHeartbeatTimer();
    this.electionCallback = null;
    this.heartbeatCallback = null;
    this.heartbeatCount = 0;
  }

  /** Returns configured election timeout min/max range. */
  getElectionTimeoutRange(): { min: number; max: number } {
    return {
      min: this.config.electionTimeoutMin,
      max: this.config.electionTimeoutMax,
    };
  }

  /** Returns configured heartbeat interval in milliseconds. */
  getHeartbeatInterval(): number {
    return this.config.heartbeatInterval;
  }

  /**
   * Validates timer configuration against Raft timing constraints.
   *
   * @param config Timing configuration to validate.
   * @throws TimerManagerError When any configured value is invalid.
   */
  private validateConfig(config: TimerConfig) {
    if (!Number.isInteger(config.electionTimeoutMin) || config.electionTimeoutMin <= 0) {
      throw new TimerManagerError(`Invalid electionTimeoutMin: ${config.electionTimeoutMin}. Must be > 0.`);
    }

    if (!Number.isInteger(config.electionTimeoutMax) || config.electionTimeoutMax < config.electionTimeoutMin) {
      throw new TimerManagerError(
        `Invalid election timeout range: max (${config.electionTimeoutMax}) must be >= min (${config.electionTimeoutMin}).`,
      );
    }

    if (!Number.isInteger(config.heartbeatInterval) || config.heartbeatInterval <= 0) {
      throw new TimerManagerError(`Invalid heartbeatInterval: ${config.heartbeatInterval}. Must be > 0.`);
    }

    if (config.electionTimeoutMin < TimerManager.minRatio * config.heartbeatInterval) {
      throw new TimerManagerError(
        `Election timeout min (${config.electionTimeoutMin}) must be at least ${TimerManager.minRatio} times the heartbeat interval (${config.heartbeatInterval}).`,
      );
    }

    /* can never happen
        if (config.electionTimeoutMax < TimerManager.minRatio * config.heartbeatInterval) {
            throw new TimerManagerError(`Election timeout max (${config.electionTimeoutMax}) must be at least ${TimerManager.minRatio} times the heartbeat interval (${config.heartbeatInterval}).`);
        }
        */
  }

  /** Returns a randomized election timeout within configured range. */
  private getRandomElectionTimeout(): number {
    const { min, max } = this.getElectionTimeoutRange();
    return this.random.nextInt(min, max);
  }

  /** Schedules the next heartbeat callback invocation. */
  private scheduleNextHeartbeat(): void {
    /* can never happen
        if (!this.heartbeatCallback) {
            return;
        }
        */

    /*
        if (this.heartbeatCount >= TimerManager.maxHeartBeats) {
            this.logger.warn(`Reached maximum heartbeat count (${TimerManager.maxHeartBeats}). Stopping heartbeat timer to prevent potential issues.`);
            this.stopHeartbeatTimer();
            return;
        }

        this.heartbeatCount++;
        */

    this.heartbeatTimer = this.clock.setTimeout(() => {
      try {
        const maybePromise = this.heartbeatCallback?.();
        if (maybePromise && typeof maybePromise.then === 'function') {
          void maybePromise.catch((error: unknown) => {
            this.logger.error(`Error in heartbeat timer callback`, { error });
          });
        }
      } catch (error) {
        this.logger.error(`Error in heartbeat timer callback`, { error });
      } finally {
        this.scheduleNextHeartbeat();
      }
    }, this.getHeartbeatInterval());
  }
}
