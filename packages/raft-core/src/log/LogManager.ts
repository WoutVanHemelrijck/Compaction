// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { LogEntry, validateLogEntry, Command, LogEntryType } from './LogEntry';
import { StorageError, LogInconsistencyError } from '../util/Error';
import { LogStorage } from '../storage/interfaces/LogStorage';
import { RaftEventBus } from '../events/RaftEvents';
import { NoOpEventBus } from '../events/EventBus';
import { NodeId } from '../core/Config';
import { ClusterConfig } from '../config/ClusterConfig';

/**
 * Log management contract for append, query, truncation, and compaction operations.
 */
export interface LogManagerInterface {
  initialize(): Promise<void>;
  appendEntry(entry: LogEntry): Promise<number>;
  appendEntries(entries: LogEntry[]): Promise<number>;
  getEntry(index: number): Promise<LogEntry | null>;
  getEntries(fromIndex: number, toIndex: number): Promise<LogEntry[]>;
  getFirstIndex(): number;
  getTermAtIndex(index: number): Promise<number | null>;
  hasMatchingEntry(index: number, term: number): Promise<boolean>;
  getLastEntry(): Promise<LogEntry | null>;
  getLastIndex(): number;
  getLastTerm(): number;
  deleteEntriesFrom(index: number): Promise<void>;
  clear(): Promise<void>;
  discardEntriesUpTo(index: number, term: number): Promise<void>;
  //
  debug_readMeta(): Promise<void>;
}

/**
 * Storage-backed Raft log manager with in-memory metadata cache.
 *
 * @remarks
 * Enforces index/term consistency and coordinates append/truncate/compact behaviors
 * used by leader replication and follower conflict resolution.
 */
export class LogManager implements LogManagerInterface {
  private lastIndex: number = 0;
  private lastTerm: number = 0;
  private snapshotIndex: number = 0;
  private snapshotTerm: number = 0;
  private initialized: boolean = false;

  constructor(
    private readonly logStorage: LogStorage,
    private readonly eventBus: RaftEventBus = new NoOpEventBus(),
    private readonly nodeId: NodeId | null = null,
  ) {}

  /**
   * Initializes in-memory metadata from persistent log storage.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.safeStorage(async () => {
      const meta = await this.logStorage.readMeta();
      this.lastIndex = meta.lastIndex;
      this.lastTerm = meta.lastTerm;
      this.snapshotIndex = meta.snapshotIndex;
      this.snapshotTerm = meta.snapshotTerm;
      this.initialized = true;
    }, 'initialize');
  }

  /**
   * Appends a single validated entry at the next expected index.
   *
   * @param entry Entry to append.
   * @returns Appended entry index.
   * @throws LogInconsistencyError When entry index is not contiguous.
   */
  async appendEntry(entry: LogEntry): Promise<number> {
    this.ensureInitialized();

    validateLogEntry(entry);

    if (entry.index !== this.lastIndex + 1) {
      throw new LogInconsistencyError(`Entry index ${entry.index} does not match expected index ${this.lastIndex + 1}`);
    }

    await this.safeStorage(async () => {
      await this.logStorage.append([entry]);
      this.lastIndex = entry.index;
      this.lastTerm = entry.term;
    }, `appendEntry (${entry.index})`);

    if (this.nodeId) {
      this.eventBus.emit({
        eventId: crypto.randomUUID(),
        timestamp: performance.now(),
        wallTime: Date.now(),
        nodeId: this.nodeId,
        type: 'LogAppended',
        entries: [entry],
        term: entry.term,
      });
    }

    return entry.index;
  }

  /**
   * Appends a contiguous sequence of validated entries.
   *
   * @param entries Entries to append.
   * @returns Updated last log index.
   * @throws LogInconsistencyError When sequence indices are not contiguous.
   */
  async appendEntries(entries: LogEntry[]): Promise<number> {
    this.ensureInitialized();

    if (entries.length === 0) {
      return this.lastIndex;
    }

    for (let i = 0; i < entries.length; i++) {
      const expectedIndex = this.lastIndex + 1 + i;
      if (entries[i].index !== expectedIndex) {
        throw new LogInconsistencyError(
          `Entry index ${entries[i].index} does not match expected index ${expectedIndex}`,
        );
      }
    }

    for (const entry of entries) {
      validateLogEntry(entry);
    }

    const lastEntry = entries[entries.length - 1];

    await this.safeStorage(async () => {
      await this.logStorage.append(entries);
      this.lastIndex = lastEntry.index;
      this.lastTerm = lastEntry.term;
    }, `appendEntries (${entries.length} entries)`);

    if (this.nodeId) {
      this.eventBus.emit({
        eventId: crypto.randomUUID(),
        timestamp: performance.now(),
        wallTime: Date.now(),
        nodeId: this.nodeId,
        type: 'LogAppended',
        entries: entries,
        term: lastEntry.term,
      });
    }

    return this.lastIndex;
  }

  /**
   * Reads a single entry by index.
   *
   * @param index Log index to read.
   * @returns Entry if present in retained log range, otherwise null.
   */
  async getEntry(index: number): Promise<LogEntry | null> {
    this.ensureInitialized();

    if (index <= this.snapshotIndex || index > this.lastIndex) {
      return null;
    }

    return await this.safeStorage(async () => {
      return await this.logStorage.getEntry(index);
    }, `getEntry (${index})`);
  }

  /**
   * Reads entries in an inclusive index range.
   *
   * @param fromIndex Inclusive start index.
   * @param toIndex Inclusive end index.
   * @returns Entries in the requested range.
   * @throws LogInconsistencyError When range is invalid for retained log bounds.
   */
  async getEntries(fromIndex: number, toIndex: number): Promise<LogEntry[]> {
    this.ensureInitialized();

    if (fromIndex <= this.snapshotIndex || toIndex > this.lastIndex || fromIndex > toIndex) {
      throw new LogInconsistencyError(`Invalid index range: from ${fromIndex} to ${toIndex}. Error if: 
        ${fromIndex} <= ${this.snapshotIndex} || 
        ${toIndex} > ${this.lastIndex} || 
        ${fromIndex} > ${toIndex})
        `);
    }

    return await this.safeStorage(async () => {
      return await this.logStorage.getEntries(fromIndex, toIndex);
    }, `getEntries (${fromIndex} to ${toIndex})`);
  }

  //
  async debug_getAllLogEntries(): Promise<LogEntry[]> {
    this.ensureInitialized();

    return await this.safeStorage(async () => {
      return await this.logStorage.debug_getAllLogEntries();
    }, `got all log entries`);
  }
  //

  /**
   * Returns first retained log index after snapshot compaction.
   *
   * @returns First retained index.
   * @throws LogInconsistencyError When both log and snapshot are empty.
   */
  getFirstIndex(): number {
    this.ensureInitialized();
    if (this.lastIndex === 0 && this.snapshotIndex === 0) {
      throw new LogInconsistencyError('No log entries found');
    }
    return this.snapshotIndex + 1;
  }

  /**
   * Returns term at given index, including snapshot boundary index.
   *
   * @param index Index to inspect.
   * @returns Term if known, otherwise null.
   */
  async getTermAtIndex(index: number): Promise<number | null> {
    this.ensureInitialized();

    if (index === this.snapshotIndex) {
      return this.snapshotTerm;
    }

    const entry = await this.getEntry(index);
    return entry ? entry.term : null;
  }

  /**
   * Checks whether local log has an entry with matching index and term.
   *
   * @param index Candidate index.
   * @param term Candidate term.
   * @returns True when index/term pair matches local state.
   */
  async hasMatchingEntry(index: number, term: number): Promise<boolean> {
    this.ensureInitialized();

    if (index === 0) {
      return true;
    }

    if (index === this.snapshotIndex) {
      return this.snapshotTerm === term;
    }

    if (index < this.snapshotIndex) {
      return false;
    }

    const entry = await this.getEntry(index);
    return entry !== null && entry.term === term;
  }

  /**
   * Returns the last retained log entry.
   *
   * @returns Last entry when present outside snapshot boundary, otherwise null.
   */
  async getLastEntry(): Promise<LogEntry | null> {
    this.ensureInitialized();

    if (this.lastIndex === 0) {
      return null;
    }

    if (this.lastIndex === this.snapshotIndex) {
      return null;
    }

    return await this.getEntry(this.lastIndex);
  }

  /** Returns current last retained log index. */
  getLastIndex(): number {
    this.ensureInitialized();
    return this.lastIndex;
  }

  /** Returns term associated with current last retained log index. */
  getLastTerm(): number {
    this.ensureInitialized();
    return this.lastTerm;
  }

  /**
   * Truncates entries starting at the provided index.
   *
   * @param index First index to remove.
   * @throws LogInconsistencyError When index is outside valid retained range.
   */
  async deleteEntriesFrom(index: number): Promise<void> {
    this.ensureInitialized();

    if (index <= this.snapshotIndex) {
      throw new LogInconsistencyError(
        `Cannot delete from index ${index} as it is less than or equal to snapshot index ${this.snapshotIndex}`,
      );
    }

    if (index > this.lastIndex) {
      throw new LogInconsistencyError(`Cannot delete from index ${index} as it is beyond last index ${this.lastIndex}`);
    }

    await this.safeStorage(async () => {
      await this.logStorage.truncateFrom(index);

      const meta = await this.logStorage.readMeta();
      this.lastIndex = meta.lastIndex;
      this.lastTerm = meta.lastTerm;
    }, `deleteEntriesFrom (${index})`);
  }

  //
  async debug_readMeta() {
    console.log(await this.logStorage.readMeta());
  }

  /**
   * Clears all retained entries after the snapshot boundary.
   */
  async clear(): Promise<void> {
    this.ensureInitialized();

    if (this.lastIndex <= this.snapshotIndex) {
      return;
    }

    await this.deleteEntriesFrom(this.snapshotIndex + 1);
  }

  /**
   * Reads all retained entries from a starting index to current last index.
   *
   * @param index Inclusive starting index.
   * @returns Entries from index to lastIndex, or empty array when index is ahead.
   */
  async getEntriesFromIndex(index: number): Promise<LogEntry[]> {
    this.ensureInitialized();

    if (index <= this.snapshotIndex) {
      throw new LogInconsistencyError(
        `Invalid fromIndex: ${index} is less than or equal to snapshot index ${this.snapshotIndex}`,
      );
    }

    if (index > this.lastIndex) {
      return [];
    }

    return await this.getEntries(index, this.lastIndex);
  }

  /**
   * Applies leader entries from a previous index, resolving conflicts by truncation.
   *
   * @param prevLogIndex Previous index preceding incoming entries.
   * @param entries Incoming entries from leader.
   * @returns Updated last index after reconciliation.
   */
  async appendEntriesFrom(prevLogIndex: number, entries: LogEntry[]): Promise<number> {
    this.ensureInitialized();

    if (entries.length === 0) {
      return this.lastIndex;
    }

    let truncateFromIndex: number | null = null;
    for (const newEntry of entries) {
      const existing = await this.getEntry(newEntry.index);

      if (existing === null) {
        break;
      }

      if (existing.term !== newEntry.term) {
        truncateFromIndex = newEntry.index;
        break;
      }
    }

    if (truncateFromIndex !== null) {
      if (this.nodeId) {
        this.eventBus.emit({
          eventId: crypto.randomUUID(),
          timestamp: performance.now(),
          wallTime: Date.now(),
          nodeId: this.nodeId,
          type: 'LogConflictResolved',
          newEntries: entries,
          truncatedFromIndex: truncateFromIndex,
          term: entries[0].term,
        });
      }

      await this.deleteEntriesFrom(truncateFromIndex);
    }

    const toAppend = entries.filter((e) => e.index > this.lastIndex);

    if (toAppend.length === 0) {
      return this.lastIndex;
    }

    return await this.appendEntries(toAppend);
  }

  /**
   * Validates whether local log matches leader previous log reference.
   *
   * @param prevLogIndex Previous log index from leader request.
   * @param prevLogTerm Previous log term from leader request.
   * @returns True when previous log reference is consistent.
   */
  async matchesPrevLog(prevLogIndex: number, prevLogTerm: number): Promise<boolean> {
    this.ensureInitialized();

    if (prevLogIndex === 0) {
      return prevLogTerm === 0;
    }

    if (prevLogIndex === this.snapshotIndex) {
      return this.snapshotTerm === prevLogTerm;
    }

    const entry = await this.getEntry(prevLogIndex);

    if (!entry) {
      return false;
    }

    return entry.term === prevLogTerm;
  }

  /**
   * Computes conflict hint for AppendEntries rejection optimization.
   *
   * @param prevLogIndex Candidate previous index from leader.
   * @returns Conflict index/term pair for leader backtracking.
   */
  async getConflictInfo(prevLogIndex: number): Promise<{ conflictIndex: number; conflictTerm: number }> {
    this.ensureInitialized();

    if (prevLogIndex > this.lastIndex) {
      return { conflictIndex: this.lastIndex + 1, conflictTerm: 0 };
    }

    const entryConflict = await this.getEntry(prevLogIndex);

    if (!entryConflict) {
      return { conflictIndex: this.lastIndex + 1, conflictTerm: 0 };
    }

    const conflictTerm = entryConflict.term;

    let conflictIndex = prevLogIndex;

    while (conflictIndex > this.snapshotIndex + 1) {
      const entry = await this.getEntry(conflictIndex - 1);
      if (!entry || entry.term !== conflictTerm) {
        break;
      }
      conflictIndex--;
    }

    return { conflictIndex, conflictTerm };
  }

  /**
   * Appends a command entry at the next log index.
   *
   * @param command Command payload.
   * @param term Term for the new entry.
   * @returns Appended index.
   */
  async appendCommand(command: Command, term: number): Promise<number> {
    const idx = this.lastIndex + 1;

    const entry: LogEntry = {
      index: idx,
      term: term,
      type: LogEntryType.COMMAND,
      command: command,
    };

    await this.appendEntry(entry);

    return idx;
  }

  /**
   * Compacts retained log entries up to and including the provided index.
   *
   * @param index Last index to compact into snapshot boundary.
   * @param term Term at compacted index.
   * @throws LogInconsistencyError When index exceeds current last index.
   */
  async discardEntriesUpTo(index: number, term: number): Promise<void> {
    this.ensureInitialized();

    if (index <= this.snapshotIndex) {
      return;
    }

    if (index > this.lastIndex) {
      throw new LogInconsistencyError(
        `Cannot discard up to index ${index} as it is beyond last index ${this.lastIndex}`,
      );
    }

    await this.safeStorage(async () => {
      await this.logStorage.compact(index, term);

      const meta = await this.logStorage.readMeta();
      this.snapshotIndex = meta.snapshotIndex;
      this.snapshotTerm = meta.snapshotTerm;
      this.lastIndex = meta.lastIndex;
      this.lastTerm = meta.lastTerm;
    }, `discardEntriesUpTo (${index})`);
  }

  /**
   * Resets log state to snapshot boundary after receiving a newer snapshot.
   *
   * @param snapshotIndex Snapshot last included index.
   * @param snapshotTerm Snapshot last included term.
   */
  async resetToSnapshot(snapshotIndex: number, snapshotTerm: number): Promise<void> {
    this.ensureInitialized();

    await this.safeStorage(async () => {
      await this.logStorage.reset(snapshotIndex, snapshotTerm);

      this.snapshotIndex = snapshotIndex;
      this.snapshotTerm = snapshotTerm;
      this.lastIndex = snapshotIndex;
      this.lastTerm = snapshotTerm;
    }, `resetToSnapshot (${snapshotIndex})`);
  }

  /** Returns current snapshot boundary index tracked by the log manager. */
  getSnapshotIndex(): number {
    this.ensureInitialized();
    return this.snapshotIndex;
  }

  /**
   * Appends a configuration-change entry at the next log index.
   *
   * @param config Cluster configuration payload.
   * @param term Term for the new entry.
   * @returns Appended index.
   */
  async appendConfigEntry(config: ClusterConfig, term: number): Promise<number> {
    const idx = this.lastIndex + 1;

    const entry: LogEntry = {
      index: idx,
      term: term,
      type: LogEntryType.CONFIG,
      config: config,
    };

    await this.appendEntry(entry);

    return idx;
  }

  /**
   * Returns the most recent configuration entry from retained log.
   *
   * @returns Last configuration entry, or null when none exists.
   */
  async getLastConfigEntry(): Promise<ClusterConfig | null> {
    this.ensureInitialized();

    for (let i = this.lastIndex; i > this.snapshotIndex; i--) {
      const entry = await this.getEntry(i);
      if (entry && entry.type === LogEntryType.CONFIG && entry.config) {
        return entry.config;
      }
    }

    return null;
  }

  /**
   * Appends a no-op entry for leader term establishment.
   *
   * @param term Term for the no-op entry.
   * @returns Appended index.
   */
  async appendNoOpEntry(term: number): Promise<number> {
    const idx = this.lastIndex + 1;

    const entry: LogEntry = {
      index: idx,
      term: term,
      type: LogEntryType.NOOP,
    };

    await this.appendEntry(entry);

    return idx;
  }

  //
  async appendDropLogEntry(term: number, startIdx: number, finalIdx: number): Promise<number> {
    const idx = this.lastIndex + 1;

    const entry: LogEntry = {
      index: idx,
      term: term,
      type: LogEntryType.DROPLOG,
      startIdx: startIdx,
      finalIdx: finalIdx + 1, // also drop the DROPLOG entry itself
    };

    await this.appendEntry(entry);

    return idx;
  }

  /**
   * Wraps storage operations and normalizes unexpected errors as StorageError.
   *
   * @param fn Operation to execute.
   * @param context Human-readable operation context.
   * @returns Result of the operation.
   */
  private async safeStorage<T>(fn: () => Promise<T>, context: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof StorageError || err instanceof LogInconsistencyError) {
        throw err;
      }
      throw new StorageError(`Storage operation failed in context: ${context}`, err as Error);
    }
  }

  /** Ensures initialize has run before log operations are used. */
  private ensureInitialized() {
    if (!this.initialized) {
      throw new StorageError('LogManager is not initialized');
    }
  }
}
