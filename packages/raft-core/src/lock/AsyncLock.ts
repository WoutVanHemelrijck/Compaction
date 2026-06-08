// @author Mathias Bouhon Keulen
// @date 2026-03-20
/**
 * Minimal FIFO async mutual exclusion lock.
 */
export class AsyncLock {
  private locked: boolean = false;
  private queue: Array<() => void> = [];

  /**
   * Acquires lock when available or waits until current holder releases.
   */
  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  /**
   * Releases lock and wakes next queued waiter if present.
   *
   * @throws Error When lock is not currently held.
   */
  release(): void {
    if (!this.locked) {
      throw new Error('Cannot release an unlocked lock');
    }

    if (this.queue.length > 0) {
      const nextResolve = this.queue.shift()!;
      nextResolve();
    } else {
      this.locked = false;
    }
  }

  /**
   * Executes callback while holding lock and always releases afterwards.
   *
   * @param callback Async critical section body.
   * @returns Callback result.
   */
  async runExclusive<T>(callback: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await callback();
    } finally {
      this.release();
    }
  }

  /** Returns true when lock is currently held. */
  isLocked(): boolean {
    return this.locked;
  }

  /** Returns number of waiters queued for lock acquisition. */
  getQueueLength(): number {
    return this.queue.length;
  }
}
