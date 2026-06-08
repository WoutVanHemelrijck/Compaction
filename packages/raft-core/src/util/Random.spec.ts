// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { describe, it, expect } from 'vitest';
import { SeededRandom, SystemRandom } from './Random';

describe('Random.ts, SeededRandom', () => {
  it('should generate the same sequence for the same seed', () => {
    const seed = 12345;
    const random1 = new SeededRandom(seed);
    const random2 = new SeededRandom(seed);

    for (let i = 0; i < 10; i++) {
      expect(random1.nextInt(0, 100)).toBe(random2.nextInt(0, 100));
    }
  });

  it('should throw if min is greater than or equal to max', () => {
    const random = new SeededRandom(123);
    expect(() => random.nextInt(10, 5)).toThrow('min must be less than max');
    expect(() => random.nextInt(5, 5)).toThrow('min must be less than max');
  });

  it('should reset seed correctly', () => {
    const random = new SeededRandom(123);
    const firstValue = random.nextInt(0, 100);
    random.reset(123);
    const secondValue = random.nextInt(0, 100);
    expect(firstValue).toBe(secondValue);
  });

  it('should return the current seed', () => {
    const seed = 123;
    const random = new SeededRandom(seed);
    expect(random.getSeed()).toBe(seed);
  });

  it('should generate different sequences for different seeds', () => {
    const random1 = new SeededRandom(123);
    const random2 = new SeededRandom(456);

    let different = false;
    for (let i = 0; i < 10; i++) {
      if (random1.nextInt(0, 100) !== random2.nextInt(0, 100)) {
        different = true;
        break;
      }
    }
    expect(different).toBe(true);
  });
});

describe('Random.ts, SystemRandom', () => {
  it('should throw if min is greater than or equal to max', () => {
    const random = new SystemRandom();
    expect(() => random.nextInt(10, 5)).toThrow('min must be less than max');
    expect(() => random.nextInt(5, 5)).toThrow('min must be less than max');
  });

  it('should generate integers within the specified range', () => {
    const random = new SystemRandom();
    for (let i = 0; i < 100; i++) {
      const value = random.nextInt(0, 10);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(10);
    }
  });

  it('should generate floats between 0 and 1', () => {
    const random = new SystemRandom();
    for (let i = 0; i < 100; i++) {
      const value = random.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
