// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { describe, it, expect } from 'vitest';
import { MockClock, SystemClock } from './Clock';

describe('Clock.ts, MockClock', () => {
  it('should return the current time', () => {
    const clock = new MockClock();
    expect(clock.now()).toBe(0);
  });

  it('should set and clear timeouts', () => {
    const clock = new MockClock();
    let callbackCalled = false;
    const timerId = clock.setTimeout(() => {
      callbackCalled = true;
    }, 100);

    expect(callbackCalled).toBe(false);
    clock.advanceMs(50);
    expect(callbackCalled).toBe(false);
    clock.advanceMs(50);
    expect(callbackCalled).toBe(true);
    callbackCalled = false;

    clock.clearTimeout(timerId);
    clock.advanceMs(100);
    expect(callbackCalled).toBe(false);
  });

  it('should throw in clearTimeout if handle is invalid', () => {
    const clock = new MockClock();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    expect(() => clock.clearTimeout('invalid' as any)).toThrow('Invalid timer handle type');
  });

  it('should throw in advanceMs if ms is negative', () => {
    const clock = new MockClock();
    expect(() => clock.advanceMs(-100)).toThrow('Cannot advance time by a negative amount');
  });

  it('should advance correctly', () => {
    const clock = new MockClock();
    clock.advanceMs(100);
    expect(clock.now()).toBe(100);
  });

  it('should advance async correctly', async () => {
    const clock = new MockClock();
    await clock.advanceAsyncMs(100);
    expect(clock.now()).toBe(100);
  });

  it('should advance to next timer correctly', () => {
    const clock = new MockClock();
    let callbackCalled = false;
    clock.setTimeout(() => {
      callbackCalled = true;
    }, 500);

    const timeAdvanced = clock.advanceToNextTimer();
    expect(timeAdvanced).toBe(500);
    expect(callbackCalled).toBe(true);
  });

  it('should return 0 from advanceToNextTimer if no timers are pending', () => {
    const clock = new MockClock();
    const timeAdvanced = clock.advanceToNextTimer();
    expect(timeAdvanced).toBe(0);
  });

  it('should advance to next timer async correctly', async () => {
    const clock = new MockClock();
    let callbackCalled = false;
    clock.setTimeout(() => {
      callbackCalled = true;
    }, 500);

    const timeAdvanced = await clock.advanceToNextTimerAsync();
    expect(timeAdvanced).toBe(500);
    expect(callbackCalled).toBe(true);
  });

  it('should advance to end correctly', () => {
    const clock = new MockClock();
    let callback1Called = false;
    let callback2Called = false;
    clock.setTimeout(() => {
      callback1Called = true;
    }, 100);
    clock.setTimeout(() => {
      callback2Called = true;
    }, 200);
    clock.advanceToEnd();
    expect(callback1Called).toBe(true);
    expect(callback2Called).toBe(true);
  });

  it('should advance to end async correctly', async () => {
    const clock = new MockClock();
    let callback1Called = false;
    let callback2Called = false;
    clock.setTimeout(() => {
      callback1Called = true;
    }, 100);
    clock.setTimeout(() => {
      callback2Called = true;
    }, 200);
    await clock.advanceToEndAsync();
    expect(callback1Called).toBe(true);
    expect(callback2Called).toBe(true);
  });

  it('should tick correctly', async () => {
    const clock = new MockClock();
    let callbackCalled = false;
    clock.setTimeout(() => {
      callbackCalled = true;
    }, 100);
    await clock.tick();
    expect(callbackCalled).toBe(false);
    clock.advanceMs(100);
    await clock.tick();
    expect(callbackCalled).toBe(true);
  });

  it('should tick multiple times correctly', async () => {
    const clock = new MockClock();
    let callbackCalled = false;
    clock.setTimeout(() => {
      callbackCalled = true;
    }, 100);
    await clock.tickMultiple(5);
    expect(callbackCalled).toBe(false);
    clock.advanceMs(100);
    await clock.tickMultiple(5);
    expect(callbackCalled).toBe(true);
  });

  it('should run until idle correctly', async () => {
    const clock = new MockClock();
    let callback1Called = false;
    let callback2Called = false;
    clock.setTimeout(() => {
      callback1Called = true;
      clock.setTimeout(() => {
        callback2Called = true;
      }, 0);
    }, 0);
    await clock.runUntilIdle();
    expect(callback1Called).toBe(true);
    expect(callback2Called).toBe(true);
  });

  it('should throw error if too mnay timers in runUntilIdle', async () => {
    const clock = new MockClock();
    clock.setTimeout(() => {
      clock.setTimeout(() => {
        clock.setTimeout(() => {}, 0);
      }, 0);
    }, 0);
    await expect(clock.runUntilIdle(2)).rejects.toThrow('Too many timers, possible infinite loop');
  });

  it('should return pending timer count', () => {
    const clock = new MockClock();
    expect(clock.getPendingTimersCount()).toBe(0);
    clock.setTimeout(() => {}, 100);
    expect(clock.getPendingTimersCount()).toBe(1);
  });

  it('should return pending timers', () => {
    const clock = new MockClock();
    const timer1 = clock.setTimeout(() => {}, 100);
    const timer2 = clock.setTimeout(() => {}, 200);
    const pendingTimers = clock.getPendingTimers();
    expect(pendingTimers.length).toBe(2);
    expect(pendingTimers.some((t) => t.id === timer1)).toBe(true);
    expect(pendingTimers.some((t) => t.id === timer2)).toBe(true);
  });

  it('should reset correctly', () => {
    const clock = new MockClock();
    clock.setTimeout(() => {}, 100);
    expect(clock.getPendingTimersCount()).toBe(1);
    clock.reset();
    expect(clock.getPendingTimersCount()).toBe(0);
  });

  it('should throw if maxIterations is reached in advanceToEnd', () => {
    const clock = new MockClock();

    clock.setTimeout(() => {
      clock.setTimeout(() => {}, 0);
    }, 0);

    expect(() => clock.advanceToEnd()).toThrow('Too many timers, possible infinite loop');
  });

  it('should throw if maxIterations is reached in advanceToEndAsync', async () => {
    const clock = new MockClock();

    clock.setTimeout(() => {
      clock.setTimeout(() => {}, 0);
    }, 0);

    await expect(clock.advanceToEndAsync()).rejects.toThrow('Too many timers, possible infinite loop');
  });

  it('should sort timers by fire time', () => {
    const clock = new MockClock();
    const list: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const timer1 = clock.setTimeout(() => {
      list.push(1);
    }, 200);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const timer2 = clock.setTimeout(() => {
      list.push(2);
    }, 100);
    clock.advanceMs(300);
    expect(list).toEqual([2, 1]);
  });
});

describe('Clock.ts, SystemClock', () => {
  it('should return the current time', () => {
    const clock = new SystemClock();
    const t1 = Date.now();
    const t2 = clock.now();
    const t3 = Date.now();
    expect(t2).toBeGreaterThanOrEqual(t1);
    expect(t2).toBeLessThanOrEqual(t3);
  });

  it('should schedule a callback with setTimeout', async () => {
    const clock = new SystemClock();
    let callbackCalled = false;
    const timer = clock.setTimeout(() => {
      callbackCalled = true;
    }, 10);
    expect(callbackCalled).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callbackCalled).toBe(true);
    clock.clearTimeout(timer);
  });

  it('should clear a timeout with clearTimeout', async () => {
    const clock = new SystemClock();
    let callbackCalled = false;
    const timer = clock.setTimeout(() => {
      callbackCalled = true;
    }, 10);
    clock.clearTimeout(timer);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callbackCalled).toBe(false);
  });

  it('should throw in clearTimeout if handle is invalid', () => {
    const clock = new SystemClock();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    expect(() => clock.clearTimeout(123 as any)).toThrow('Invalid timer handle type');
  });
});
