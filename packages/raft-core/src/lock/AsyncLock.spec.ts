// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { describe, it, expect, beforeEach } from 'vitest';
import { AsyncLock } from './AsyncLock';

describe('AsyncLock.ts, AsyncLock', () => {
  let lock: AsyncLock;

  beforeEach(() => {
    lock = new AsyncLock();
  });

  it('should immediately acquire lock if it is not locked', async () => {
    await lock.acquire();
    expect(lock.isLocked()).toBe(true);
    expect(lock.getQueueLength()).toBe(0);
  });

  it('should await when trying to acquire a locked lock', async () => {
    await lock.acquire();

    let secondAcquired = false;
    const secondAcquirePromise = lock.acquire().then(() => {
      secondAcquired = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(secondAcquired).toBe(false);
    expect(lock.getQueueLength()).toBe(1);

    lock.release();
    await secondAcquirePromise;
    expect(secondAcquired).toBe(true);
    expect(lock.isLocked()).toBe(true);
    expect(lock.getQueueLength()).toBe(0);
  });

  it('should queue multiple acquirers', async () => {
    await lock.acquire();

    const acquirePromises = [lock.acquire(), lock.acquire(), lock.acquire()];

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(lock.getQueueLength()).toBe(3);

    lock.release();
    await acquirePromises[0];
    expect(lock.getQueueLength()).toBe(2);

    lock.release();
    await acquirePromises[1];
    expect(lock.getQueueLength()).toBe(1);

    lock.release();
    await acquirePromises[2];
    expect(lock.getQueueLength()).toBe(0);
    expect(lock.isLocked()).toBe(true);
  });

  it('should throw error when releasing an unlocked lock', () => {
    expect(() => lock.release()).toThrow('Cannot release an unlocked lock');
  });

  it('should unlock when no queue is waiting', async () => {
    await lock.acquire();
    expect(lock.isLocked()).toBe(true);
    lock.release();
    expect(lock.isLocked()).toBe(false);
  });

  it('should pass lock to next in queue', async () => {
    await lock.acquire();

    let secondAcquired = false;
    const secondAcquirePromise = lock.acquire().then(() => {
      secondAcquired = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondAcquired).toBe(false);

    lock.release();
    await secondAcquirePromise;
    expect(secondAcquired).toBe(true);
    expect(lock.isLocked()).toBe(true);
    expect(lock.getQueueLength()).toBe(0);
  });

  it('should maintain fifo order', async () => {
    await lock.acquire();

    const acquireOrder: number[] = [];

    const acquirePromises = [
      lock.acquire().then(() => acquireOrder.push(1)),
      lock.acquire().then(() => acquireOrder.push(2)),
      lock.acquire().then(() => acquireOrder.push(3)),
    ];

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(acquireOrder).toEqual([]);

    lock.release();
    await acquirePromises[0];
    expect(acquireOrder).toEqual([1]);

    lock.release();
    await acquirePromises[1];
    expect(acquireOrder).toEqual([1, 2]);

    lock.release();
    await acquirePromises[2];
    expect(acquireOrder).toEqual([1, 2, 3]);
  });

  it('should run callback exclusively', async () => {
    let executed = false;
    const result = await lock.runExclusive(async () => {
      await Promise.resolve();
      executed = true;
      expect(lock.isLocked()).toBe(true);
      return true;
    });
    expect(executed).toBe(true);
    expect(result).toBe(true);
    expect(lock.isLocked()).toBe(false);
  });

  it('should release lock even if callback throws', async () => {
    await expect(
      lock.runExclusive(async () => {
        await Promise.resolve();
        expect(lock.isLocked()).toBe(true);
        throw new Error('Test error');
      }),
    ).rejects.toThrow('Test error');

    expect(lock.isLocked()).toBe(false);
  });

  it('should handle multiple exclusive callbacks in order', async () => {
    const executionOrder: number[] = [];
    const delays = [50, 30, 10];

    const promises = delays.map((delay, index) =>
      lock.runExclusive(async () => {
        executionOrder.push(index);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return index;
      }),
    );

    const results = await Promise.all(promises);
    expect(executionOrder).toEqual([0, 1, 2]);
    expect(results).toEqual([0, 1, 2]);
    expect(lock.isLocked()).toBe(false);
  });

  it('should properly serialize access to a shared resource', async () => {
    let counter = 0;
    const iterations = 10;

    const promises = Array.from({ length: iterations }, () =>
      lock.runExclusive(async () => {
        const current = counter;
        await new Promise((resolve) => setTimeout(resolve, 1));
        counter = current + 1;
      }),
    );

    await Promise.all(promises);
    expect(counter).toBe(iterations);
  });

  it('should return callback result', async () => {
    const result = await lock.runExclusive(async () => {
      await Promise.resolve();
      return 'exclusive result';
    });
    expect(result).toBe('exclusive result');
  });

  it('should handle sync callbacks', async () => {
    const result = await lock.runExclusive(async () => {
      await Promise.resolve();
      return 'sync result';
    });
    expect(result).toBe('sync result');
  });

  it('should return false for isLocked when not locked', () => {
    expect(lock.isLocked()).toBe(false);
  });

  it('should return true for isLocked when locked', async () => {
    await lock.acquire();
    expect(lock.isLocked()).toBe(true);
  });

  it('should return false after release with no queue', async () => {
    await lock.acquire();
    lock.release();
    expect(lock.isLocked()).toBe(false);
  });

  it('should return true for isLocked when there are queued acquirers', async () => {
    await lock.acquire();
    const secondAcquire = lock.acquire();

    lock.release();
    await secondAcquire;
    expect(lock.isLocked()).toBe(true);
  });

  it('should return 0 for no queued acquirers', () => {
    expect(lock.getQueueLength()).toBe(0);
  });

  it('should return correct queue length', async () => {
    await lock.acquire();
    void lock.acquire();
    expect(lock.getQueueLength()).toBe(1);
    void lock.acquire();
    expect(lock.getQueueLength()).toBe(2);
    void lock.acquire();
    expect(lock.getQueueLength()).toBe(3);
    lock.release();
    expect(lock.getQueueLength()).toBe(2);
    lock.release();
    expect(lock.getQueueLength()).toBe(1);
    lock.release();
    expect(lock.getQueueLength()).toBe(0);
  });

  it('should handle rapid acquire and release', async () => {
    for (let i = 0; i < 100; i++) {
      await lock.acquire();
      expect(lock.isLocked()).toBe(true);
      lock.release();
      expect(lock.isLocked()).toBe(false);
    }
  });

  it('should handle mixed runExclusive and acquire/release', async () => {
    await lock.acquire();

    const exclusivePromise = lock.runExclusive(async () => {
      await Promise.resolve();
      return 'exclusive';
    });
    const manualPromise = lock.acquire().then(() => {
      lock.release();
      return 'manual';
    });

    lock.release();

    const results = await Promise.all([exclusivePromise, manualPromise]);
    expect(results).toEqual(['exclusive', 'manual']);
    expect(lock.isLocked()).toBe(false);
  });

  it('should handle callbacks with nested runExclusive calls', async () => {
    const innerLock = new AsyncLock();

    const result = await lock.runExclusive(async () => {
      return await innerLock.runExclusive(async () => {
        await Promise.resolve();
        return 'nested exclusive';
      });
    });

    expect(result).toBe('nested exclusive');
    expect(lock.isLocked()).toBe(false);
    expect(innerLock.isLocked()).toBe(false);
  });
});
