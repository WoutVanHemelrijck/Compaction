// @author Mathias Bouhon Keulen
// @date 2026-03-20
/**
 * Random source abstraction used for election timeout jitter and tests.
 */
export interface Random {
  nextInt(min: number, max: number): number;
  nextFloat(): number;
}

/**
 * Deterministic pseudo-random generator for test scenarios.
 */
export class SeededRandom implements Random {
  private seed: number;

  /** Creates generator with initial seed. */
  constructor(seed: number) {
    this.seed = seed;
  }

  /** Returns next pseudo-random float in [0, 1). */
  nextFloat(): number {
    const a = 1664525; // LCG
    const c = 1013904223;
    const m = 2 ** 32;

    this.seed = (a * this.seed + c) % m;
    return this.seed / m;
  }

  /**
   * Returns pseudo-random integer in inclusive range [min, max].
   *
   * @throws Error When min >= max.
   */
  nextInt(min: number, max: number): number {
    if (min >= max) {
      throw new Error('min must be less than max');
    }

    const range = max - min + 1;
    return min + Math.floor(this.nextFloat() * range);
  }

  /** Resets internal seed value. */
  reset(seed: number) {
    this.seed = seed;
  }

  /** Returns current internal seed value. */
  getSeed(): number {
    return this.seed;
  }
}

/**
 * Production random source backed by Math.random.
 */
export class SystemRandom implements Random {
  /**
   * Returns random integer in inclusive range [min, max].
   *
   * @throws Error When min >= max.
   */
  nextInt(min: number, max: number): number {
    if (min >= max) {
      throw new Error('min must be less than max');
    }
    const range = max - min + 1;
    return min + Math.floor(Math.random() * range);
  }

  /** Returns random float in [0, 1). */
  nextFloat(): number {
    return Math.random();
  }
}
