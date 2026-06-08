// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { ClusterConfig } from '../../config/ClusterConfig';

/**
 * Snapshot boundary metadata.
 */
export interface SnapshotMetaData {
  /** Last index included in snapshot. */
  lastIncludedIndex: number;
  /** Term at lastIncludedIndex. */
  lastIncludedTerm: number;
}

/**
 * Full snapshot payload including serialized state and membership.
 */
export interface Snapshot extends SnapshotMetaData {
  /** Serialized application state machine bytes. */
  data: Buffer;
  /** Committed cluster config associated with snapshot. */
  config: ClusterConfig;
}

/**
 * Storage contract for snapshot persistence and retrieval.
 */
export interface SnapshotStorage {
  /** Opens storage resources. */
  open(): Promise<void>;
  /** Closes storage resources. */
  close(): Promise<void>;
  /** Returns true when storage is open. */
  isOpen(): boolean;

  /** Reads only snapshot metadata, or null when no snapshot exists. */
  readMetadata(): Promise<SnapshotMetaData | null>;

  /** Saves complete snapshot payload. */
  save(snapshot: Snapshot): Promise<void>;

  /** Loads complete snapshot payload, or null when absent. */
  load(): Promise<Snapshot | null>;
}
