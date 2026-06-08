// @author Mathias Bouhon Keulen
// @date 2026-03-20
/** Opaque timer handle type returned by clock implementations. */
export type TimerHandle = number | NodeJS.Timeout;

/**
 * Clock abstraction for time reads and timer scheduling.
 */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Internal timer record used by MockClock scheduler. */
export interface MockTimer {
  id: number;
  fireTime: number;
  callback: () => void;
}

/**
 * Deterministic test clock with controllable time progression.
 */
export class MockClock implements Clock {
  private currentTime: number = 0;
  private timers: Map<number, MockTimer> = new Map();
  private nextTimerId: number = 1;

  /** Returns current mock time in milliseconds. */
  now(): number {
    return this.currentTime;
  }

  /** Schedules a callback at currentTime + delayMs. */
  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextTimerId++;
    const fireTime = this.currentTime + delayMs;
    this.timers.set(id, { id, fireTime, callback });
    return id;
  }

  /** Clears a timer previously scheduled by MockClock. */
  clearTimeout(handle: number): void {
    if (typeof handle !== 'number') {
      throw new Error('Invalid timer handle type');
    }

    this.timers.delete(handle);
  }

  /** Advances time by ms and fires due timers. */
  advanceMs(ms: number): void {
    if (ms < 0) {
      throw new Error('Cannot advance time by a negative amount');
    }

    this.currentTime += ms;
    this.fireTimers();
  }

  /** Asynchronously advances time by ms and yields to microtasks. */
  async advanceAsyncMs(ms: number): Promise<void> {
    this.advanceMs(ms);
    await this.tick();
  }

  /** Advances time to next scheduled timer and returns amount advanced. */
  advanceToNextTimer(): number {
    const nextTimer = this.getNextTimer();
    if (!nextTimer) {
      return 0;
    }

    const timeToAdvance = Math.max(0, nextTimer.fireTime - this.currentTime);

    if (timeToAdvance > 0) {
      this.advanceMs(timeToAdvance);
    }

    return timeToAdvance;
  }

  /** Async variant of advanceToNextTimer with microtask yield. */
  async advanceToNextTimerAsync(): Promise<number> {
    const advanced = this.advanceToNextTimer();
    await this.tick();
    return advanced;
  }

  /** Advances through all pending timers until queue is empty. */
  advanceToEnd(): void {
    let iterations = 0;
    const maxIterations = 1000;

    while (this.timers.size > 0 && iterations < maxIterations) {
      this.advanceToNextTimer();
      iterations++;
    }

    if (iterations === maxIterations) {
      throw new Error('Too many timers, possible infinite loop');
    }
  }

  /** Async variant of advanceToEnd with microtask yields. */
  async advanceToEndAsync(): Promise<void> {
    let iterations = 0;
    const maxIterations = 1000;

    while (this.timers.size > 0 && iterations < maxIterations) {
      await this.advanceToNextTimerAsync();
      await this.tick();
      iterations++;
    }

    if (iterations === maxIterations) {
      throw new Error('Too many timers, possible infinite loop');
    }
  }

  /** Yields to event loop microtasks once. */
  async tick(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
  }

  /** Yields to microtasks multiple times. */
  async tickMultiple(times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      await this.tick();
    }
  }

  /**
   * Repeatedly fires due timers and yields until idle or max iterations.
   */
  async runUntilIdle(maxIterations: number = 100): Promise<void> {
    let iterations = 0;

    while (iterations < maxIterations) {
      const hadTimers = this.timers.size > 0;

      this.fireTimers();

      await this.tick();

      if (!hadTimers && this.timers.size === 0) {
        break;
      }
      iterations++;
    }

    if (iterations === maxIterations) {
      throw new Error('Too many timers, possible infinite loop');
    }
  }

  /** Fires all timers due at currentTime in deterministic order. */
  private fireTimers(): void {
    const timersToFire = Array.from(this.timers.values())
      .filter((timer) => timer.fireTime <= this.currentTime)
      .sort((a, b) => a.fireTime - b.fireTime);

    for (const timer of timersToFire) {
      this.timers.delete(timer.id);
      timer.callback();
    }
  }

  /** Returns next timer due, or null when no timers are scheduled. */
  private getNextTimer(): MockTimer | null {
    if (this.timers.size === 0) {
      return null;
    }

    let nextTimer: MockTimer | null = null;
    for (const timer of this.timers.values()) {
      if (!nextTimer || timer.fireTime < nextTimer.fireTime) {
        nextTimer = timer;
      }
    }
    return nextTimer;
  }

  /** Returns number of currently scheduled timers. */
  getPendingTimersCount(): number {
    return this.timers.size;
  }

  /** Returns scheduled timers ordered by fire time. */
  getPendingTimers(): MockTimer[] {
    return Array.from(this.timers.values()).sort((a, b) => a.fireTime - b.fireTime);
  }

  /** Clears all timers and resets mock time state. */
  reset(): void {
    this.currentTime = 0;
    this.timers.clear();
    this.nextTimerId = 1;
  }
}

/**
 * Production clock backed by system Date and timers.
 */
export class SystemClock implements Clock {
  /** Returns current system wall clock time in milliseconds. */
  now(): number {
    return Date.now();
  }

  /** Schedules callback using global setTimeout. */
  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    return global.setTimeout(callback, delayMs);
  }

  /** Clears NodeJS timeout handle returned by setTimeout. */
  clearTimeout(handle: TimerHandle): void {
    if (typeof handle === 'number') {
      throw new Error('Invalid timer handle type');
    }
    global.clearTimeout(handle);
  }
}
