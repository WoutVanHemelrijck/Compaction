// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { SnapshotStorage, Snapshot, SnapshotMetaData } from '../storage/interfaces/SnapshotStorage';
import { StorageError } from '../util/Error';

export type { SnapshotMetaData, Snapshot };

/**
 * Snapshot I/O contract for persistence and metadata access.
 */
export interface SnapshotManagerInterface {
  saveSnapshot(snapshot: Snapshot): Promise<void>;
  loadSnapshot(): Promise<Snapshot | null>;
  hasSnapshot(): boolean;
  getSnapshotMetadata(): SnapshotMetaData | null;
}

/**
 * Snapshot storage wrapper that caches metadata and enforces initialization.
 *
 * @remarks
 * Methods that read or write snapshot data require a prior `initialize()` call
 * to populate in-memory metadata from storage.
 */
export class SnapshotManager implements SnapshotManagerInterface {
  private cachedIndex: number = 0;
  private cachedTerm: number = 0;
  private initialized: boolean = false;

  constructor(private readonly snapshotStorage: SnapshotStorage) {}

  /**
   * Loads snapshot metadata from storage and primes the in-memory cache.
   *
   * @returns Snapshot metadata when a snapshot exists, otherwise null.
   */
  async initialize(): Promise<SnapshotMetaData | null> {
    if (this.initialized) {
      return this.cachedIndex > 0 ? { lastIncludedIndex: this.cachedIndex, lastIncludedTerm: this.cachedTerm } : null;
    }

    const meta = await this.snapshotStorage.readMetadata();

    if (!meta) {
      this.initialized = true;
      return null;
    }

    this.cachedIndex = meta.lastIncludedIndex;
    this.cachedTerm = meta.lastIncludedTerm;
    this.initialized = true;

    return { lastIncludedIndex: this.cachedIndex, lastIncludedTerm: this.cachedTerm };
  }

  /**
   * Persists a snapshot and updates in-memory metadata.
   *
   * @param snapshot Snapshot to persist including data, index, term, and config.
   */
  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    this.ensureInitialized();

    await this.snapshotStorage.save(snapshot);

    this.cachedIndex = snapshot.lastIncludedIndex;
    this.cachedTerm = snapshot.lastIncludedTerm;
  }

  /**
   * Loads the current snapshot from storage.
   *
   * @returns Full snapshot when one exists, otherwise null.
   */
  async loadSnapshot(): Promise<Snapshot | null> {
    this.ensureInitialized();

    if (this.cachedIndex === 0) {
      return null;
    }

    return await this.snapshotStorage.load();
  }

  /** Returns true when a snapshot has been saved and metadata is cached. */
  hasSnapshot(): boolean {
    this.ensureInitialized();
    return this.cachedIndex > 0;
  }

  /** Returns cached snapshot index and term, or null when no snapshot is present. */
  getSnapshotMetadata(): SnapshotMetaData | null {
    this.ensureInitialized();
    return this.cachedIndex > 0 ? { lastIncludedIndex: this.cachedIndex, lastIncludedTerm: this.cachedTerm } : null;
  }

  /** Throws if initialize() has not been called. */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new StorageError('SnapshotManager is not initialized. Call initialize() before using.');
    }
  }
}
