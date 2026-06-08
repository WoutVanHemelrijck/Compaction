// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { LogEntry } from '../../log/LogEntry';

/**
 * Persisted metadata describing current retained log and snapshot boundary.
 */
export interface LogStorageMeta {
  /** Last compacted index included by snapshot. */
  snapshotIndex: number;
  /** Term at snapshotIndex. */
  snapshotTerm: number;
  /** Last retained log index. */
  lastIndex: number;
  /** Term at lastIndex. */
  lastTerm: number;
}

/**
 * Storage contract for replicated log persistence and compaction.
 */
export interface LogStorage {
  /** Opens storage resources. */
  open(): Promise<void>;
  /** Closes storage resources. */
  close(): Promise<void>;
  /** Returns true when storage is open. */
  isOpen(): boolean;

  /** Reads current log metadata snapshot. */
  readMeta(): Promise<LogStorageMeta>;

  /** Appends entries at the end of log. */
  append(entries: LogEntry[]): Promise<void>;

  /** Reads one entry by index. */
  getEntry(index: number): Promise<LogEntry | null>;

  /** Reads entries in inclusive index range. */
  getEntries(from: number, to: number): Promise<LogEntry[]>;

  debug_getAllLogEntries(): Promise<LogEntry[]>;

  /** Truncates log from provided index to end. */
  truncateFrom(index: number): Promise<void>;

  /** Compacts log up to and including index, preserving snapshot boundary. */
  compact(upToIndex: number, term: number): Promise<void>;

  /** Resets retained log state to snapshot boundary. */
  reset(snapshotIndex: number, snapshotTerm: number): Promise<void>;
}
