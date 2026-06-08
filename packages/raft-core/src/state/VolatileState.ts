// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { VolatileStateError } from '../util/Error';

/**
 * Point-in-time view of volatile Raft state for testing and diagnostics.
 */
export interface VolatileStateSnapshot {
  /** Highest log index known to be committed. */
  commitIndex: number;
  /** Highest log index applied to the application state machine. */
  lastApplied: number;
}

/**
 * Contract for in-memory Raft volatile state that does not survive restarts.
 */
export interface VolatileStateInterface {
  getCommitIndex(): number;
  setCommitIndex(index: number): void;
  // advanceCommitIndex(): void;
  getLastApplied(): number;
  // setLastApplied(index: number): void;
  advanceLastApplied(): number;
  needsApplication(): boolean;
  getNextIndexToApply(): number | null;
  getPendingApplicationsCount(): number;
  reset(): void;
  snapshot(): VolatileStateSnapshot;
}

/**
 * In-memory Raft volatile state tracking commit progress and apply lag.
 *
 * @remarks
 * Not persisted. Reset to zero on each node start. commitIndex and lastApplied
 * are only allowed to advance monotonically.
 */
export class VolatileState implements VolatileStateInterface {
  private commitIndex: number = 0;
  private lastApplied: number = 0;

  /** Returns the highest log index known to be committed on this node. */
  getCommitIndex(): number {
    return this.commitIndex;
  }

  /**
   * Advances the commit index.
   *
   * @param index New commit index, must be >= current.
   * @throws VolatileStateError When index would decrease commitIndex.
   */
  setCommitIndex(index: number): void {
    this.validateIndex(index, 'Commit index');

    if (index < this.commitIndex) {
      throw new VolatileStateError(
        `Commit index cannot be decreased (current: ${this.commitIndex}, attempted: ${index})`,
      );
    }

    this.commitIndex = index;
  }

  /** Increments commit index by one. */
  advanceCommitIndex(): void {
    this.validateIndex(this.commitIndex + 1, 'Commit index');
    this.commitIndex++;
  }

  /** Returns the highest log index applied to the application state machine. */
  getLastApplied(): number {
    return this.lastApplied;
  }

  /**
   * Sets lastApplied to the provided index.
   *
   * @param index New lastApplied, must be >= current and <= commitIndex.
   * @throws VolatileStateError When index would decrease or exceed commitIndex.
   */
  setLastApplied(index: number): void {
    this.validateIndex(index, 'Last applied index');

    if (index < this.lastApplied) {
      throw new VolatileStateError(
        `Last applied index cannot be decreased (current: ${this.lastApplied}, attempted: ${index})`,
      );
    }

    if (index > this.commitIndex) {
      throw new VolatileStateError(
        `Last applied index cannot be greater than commit index (commitIndex: ${this.commitIndex}, attempted: ${index})`,
      );
    }

    this.lastApplied = index;
  }

  /**
   * Increments lastApplied by one.
   *
   * @returns New lastApplied value.
   * @throws VolatileStateError When lastApplied would exceed commitIndex.
   */
  advanceLastApplied(): number {
    if (this.lastApplied >= this.commitIndex) {
      throw new VolatileStateError(
        `Cannot advance last applied index beyond commit index (commitIndex: ${this.commitIndex}, attempted: ${this.lastApplied + 1})`,
      );
    }

    this.lastApplied++;

    return this.lastApplied;
  }

  /** Returns true when there are committed entries not yet applied. */
  needsApplication(): boolean {
    return this.lastApplied < this.commitIndex;
  }

  /** Returns the next log index to apply, or null when caught up. */
  getNextIndexToApply(): number | null {
    if (!this.needsApplication()) {
      return null;
    }

    return this.lastApplied + 1;
  }

  /** Returns the number of committed entries not yet applied. */
  getPendingApplicationsCount(): number {
    return this.commitIndex - this.lastApplied;
  }

  /** Resets both commitIndex and lastApplied to 0 on node start. */
  reset(): void {
    this.commitIndex = 0;
    this.lastApplied = 0;
  }

  /** Returns a point-in-time snapshot of current volatile state. */
  snapshot(): VolatileStateSnapshot {
    return {
      commitIndex: this.commitIndex,
      lastApplied: this.lastApplied,
    };
  }

  restoreFromSnapshot(snapshot: VolatileStateSnapshot): void {
    this.validateIndex(snapshot.commitIndex, 'Commit index');
    this.validateIndex(snapshot.lastApplied, 'Last applied index');

    if (snapshot.commitIndex < this.commitIndex) {
      throw new VolatileStateError(
        `Cannot restore from snapshot with lower commit index (current: ${this.commitIndex}, snapshot: ${snapshot.commitIndex})`,
      );
    }

    if (snapshot.lastApplied > snapshot.commitIndex) {
      throw new VolatileStateError(
        `Snapshot last applied index cannot be greater than commit index (commitIndex: ${snapshot.commitIndex}, lastApplied: ${snapshot.lastApplied})`,
      );
    }

    this.commitIndex = snapshot.commitIndex;
    this.lastApplied = snapshot.lastApplied;
  }

  private validateIndex(value: number, name: string): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new VolatileStateError(`${name} must be a non-negative integer (got ${value})`);
    }
  }
}
