// @author Wout Van Hemelrijck
// @date 2026-05-12
//
// Async read-write lock. Lets concurrent readers share access while writers
// run exclusively. Used by the daemon middleware to serialize INSERT/UPDATE/
// DELETE/compaction operations while letting GETs proceed in parallel.
//
// Semantics:
//   - readLock(fn): runs `fn` while no writer holds (or is queued ahead of)
//     the lock. Multiple concurrent readers may overlap.
//   - writeLock(fn): runs `fn` exclusively — waits for all earlier readers
//     and writers, blocks every later operation until it resolves.
//   - Ordering is FIFO between phases: a writer queued behind a batch of
//     readers won't be starved by a later reader joining the same batch.

/**
 * In-flight read phase. While the current tail is a read phase, additional
 * readers can join it; once a writer queues (or the phase drains) the phase
 * is closed and subsequent readers start a new one behind the writer.
 */
type ReadPhase = {
  pending: number;
  release: () => void;
  gate: Promise<void>;
};

/**
 * FIFO async read-write lock. Resolve/release functions never reject, so
 * awaiting a previous phase from inside readLock/writeLock cannot throw.
 */
export class RWLock {
  private tail: Promise<void> = Promise.resolve();
  private currentReadPhase: ReadPhase | null = null;

  async readLock<T>(fn: () => Promise<T>): Promise<T> {
    let phase: ReadPhase;
    if (this.currentReadPhase !== null) {
      phase = this.currentReadPhase;
      phase.pending++;
    } else {
      const gate = this.tail;
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.tail = done;
      phase = { pending: 1, release, gate };
      this.currentReadPhase = phase;
    }
    try {
      await phase.gate;
      return await fn();
    } finally {
      phase.pending--;
      if (phase.pending === 0) {
        if (this.currentReadPhase === phase) this.currentReadPhase = null;
        phase.release();
      }
    }
  }

  async writeLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    // Close any open read phase so subsequent readers queue behind us.
    this.currentReadPhase = null;
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tail = done;
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }
}
