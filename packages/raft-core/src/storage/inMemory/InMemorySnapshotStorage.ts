// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { StorageError } from '../../util/Error';
import { Snapshot, SnapshotMetaData, SnapshotStorage } from '../interfaces/SnapshotStorage';

/**
 * In-memory SnapshotStorage implementation for tests and ephemeral runs.
 */
export class InMemorySnapshotStorage implements SnapshotStorage {
  private snapshot: Snapshot | null = null;
  private isOpenFlag = false;

  /** Opens storage handle. */
  async open(): Promise<void> {
    if (this.isOpenFlag) throw new StorageError('InMemorySnapshotStorage is already open');
    this.isOpenFlag = true;
    await Promise.resolve();
  }

  /** Closes storage handle. */
  async close(): Promise<void> {
    this.ensureOpen();
    this.isOpenFlag = false;
    await Promise.resolve();
  }

  /** Returns true when storage is open. */
  isOpen(): boolean {
    return this.isOpenFlag;
  }

  /** Reads snapshot metadata only. */
  async readMetadata(): Promise<SnapshotMetaData | null> {
    this.ensureOpen();
    await Promise.resolve();
    if (!this.snapshot) return null;
    return {
      lastIncludedIndex: this.snapshot.lastIncludedIndex,
      lastIncludedTerm: this.snapshot.lastIncludedTerm,
    };
  }

  /** Saves deep-copied snapshot payload in memory. */
  async save(snapshot: Snapshot): Promise<void> {
    await Promise.resolve();
    this.ensureOpen();
    this.snapshot = {
      lastIncludedIndex: snapshot.lastIncludedIndex,
      lastIncludedTerm: snapshot.lastIncludedTerm,
      data: Buffer.from(snapshot.data),
      config: {
        voters: snapshot.config.voters.map((m) => ({ ...m })),
        learners: snapshot.config.learners.map((m) => ({ ...m })),
      },
    };
  }

  /** Loads deep-copied snapshot payload from memory. */
  async load(): Promise<Snapshot | null> {
    await Promise.resolve();
    this.ensureOpen();
    if (!this.snapshot) return null;
    return {
      lastIncludedIndex: this.snapshot.lastIncludedIndex,
      lastIncludedTerm: this.snapshot.lastIncludedTerm,
      data: Buffer.from(this.snapshot.data),
      config: {
        voters: this.snapshot.config.voters.map((m) => ({ ...m })),
        learners: this.snapshot.config.learners.map((m) => ({ ...m })),
      },
    };
  }

  /** Throws when storage handle is not open. */
  private ensureOpen(): void {
    if (!this.isOpenFlag) throw new StorageError('InMemorySnapshotStorage is not open');
  }
}
