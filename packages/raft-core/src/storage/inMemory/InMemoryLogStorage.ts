// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { StorageError } from '../../util/Error';
import { LogEntry } from '../../log/LogEntry';
import { LogStorage, LogStorageMeta } from '../interfaces/LogStorage';

/**
 * In-memory LogStorage implementation for tests and ephemeral runs.
 */
export class InMemoryLogStorage implements LogStorage {
  private entries: Map<number, LogEntry> = new Map();
  private snapshotIndex = 0;
  private snapshotTerm = 0;
  private lastIndex = 0;
  private lastTerm = 0;
  private isOpenFlag = false;

  /** Opens storage handle. */
  async open(): Promise<void> {
    if (this.isOpenFlag) throw new StorageError('InMemoryLogStorage is already open');
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

  /** Reads cached metadata for snapshot boundary and log tail. */
  async readMeta(): Promise<LogStorageMeta> {
    this.ensureOpen();
    await Promise.resolve();
    return {
      snapshotIndex: this.snapshotIndex,
      snapshotTerm: this.snapshotTerm,
      lastIndex: this.lastIndex,
      lastTerm: this.lastTerm,
    };
  }

  /** Appends entries and updates tail metadata. */
  async append(entries: LogEntry[]): Promise<void> {
    this.ensureOpen();
    if (entries.length === 0) return;

    for (const entry of entries) {
      this.entries.set(entry.index, entry);
    }

    const last = entries[entries.length - 1];
    this.lastIndex = last.index;
    this.lastTerm = last.term;
    await Promise.resolve();
  }

  /** Reads single entry by index, excluding compacted region. */
  async getEntry(index: number): Promise<LogEntry | null> {
    this.ensureOpen();
    if (index <= this.snapshotIndex || index > this.lastIndex) return null;
    return this.entries.get(index) ?? null;
    await Promise.resolve();
  }

  /** Reads inclusive range of entries, throwing on missing indices. */
  async getEntries(from: number, to: number): Promise<LogEntry[]> {
    await Promise.resolve();
    this.ensureOpen();
    const result: LogEntry[] = [];
    for (let i = from; i <= to; i++) {
      const entry = this.entries.get(i);
      if (!entry || i <= this.snapshotIndex) {
        throw new StorageError(`Missing log entry at index ${i}`);
      }
      result.push(entry);
    }
    return result;
  }

  async debug_getAllLogEntries(): Promise<LogEntry[]> {
    // For the linter
    await new Promise((resolve) => setTimeout(resolve, 1));
    //
    throw new Error('I should never be called!');
    return [];
  }

  /** Truncates entries starting at provided index. */
  async truncateFrom(index: number): Promise<void> {
    this.ensureOpen();

    for (let i = index; i <= this.lastIndex; i++) {
      this.entries.delete(i);
    }

    const newLastIndex = index - 1;

    if (newLastIndex <= this.snapshotIndex) {
      this.lastIndex = this.snapshotIndex;
      this.lastTerm = this.snapshotTerm;
    } else {
      this.lastIndex = newLastIndex;
      const prev = this.entries.get(newLastIndex);
      this.lastTerm = prev ? prev.term : 0;
    }
    await Promise.resolve();
  }

  /** Compacts entries up to index and updates snapshot boundary metadata. */
  async compact(upToIndex: number, term: number): Promise<void> {
    this.ensureOpen();

    for (let i = this.snapshotIndex + 1; i <= upToIndex; i++) {
      this.entries.delete(i);
    }

    this.snapshotIndex = upToIndex;
    this.snapshotTerm = term;

    if (upToIndex >= this.lastIndex) {
      this.lastIndex = upToIndex;
      this.lastTerm = term;
    }
    await Promise.resolve();
  }

  /** Resets storage to provided snapshot boundary and clears retained entries. */
  async reset(snapshotIndex: number, snapshotTerm: number): Promise<void> {
    this.ensureOpen();
    this.entries.clear();
    this.snapshotIndex = snapshotIndex;
    this.snapshotTerm = snapshotTerm;
    this.lastIndex = snapshotIndex;
    this.lastTerm = snapshotTerm;
    await Promise.resolve();
  }

  /** Throws when storage handle is not open. */
  private ensureOpen(): void {
    if (!this.isOpenFlag) throw new StorageError('InMemoryLogStorage is not open');
  }
}
