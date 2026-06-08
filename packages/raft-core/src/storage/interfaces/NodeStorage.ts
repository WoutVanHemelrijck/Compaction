// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { MetaStorage } from './MetaStorage';
import { ConfigStorage } from './ConfigStorage';
import { LogStorage } from './LogStorage';
import { SnapshotStorage } from './SnapshotStorage';

/**
 * Aggregate storage contract for all Raft durable data domains.
 *
 * @remarks
 * Implementations are expected to open and close all underlying sub-storages
 * as one unit.
 */
export interface NodeStorage {
  /** Persistent term and vote state. */
  meta: MetaStorage;
  /** Cluster membership persistence. */
  config: ConfigStorage;
  /** Replicated log persistence. */
  log: LogStorage;
  /** Snapshot persistence. */
  snapshot: SnapshotStorage;
  /** Opens storage resources. */
  open(): Promise<void>;
  /** Closes storage resources. */
  close(): Promise<void>;
  /** Returns true when storage is currently open. */
  isOpen(): boolean;
}
