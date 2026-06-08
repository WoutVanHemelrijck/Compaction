// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { ClusterMember } from '../../config/ClusterConfig';

/**
 * Persisted cluster membership payload.
 */
export interface ConfigStorageData {
  /** Voting members. */
  voters: ClusterMember[];
  /** Non-voting members. */
  learners: ClusterMember[];
}

/**
 * Storage contract for committed cluster configuration.
 */
export interface ConfigStorage {
  /** Opens storage resources. */
  open(): Promise<void>;
  /** Closes storage resources. */
  close(): Promise<void>;
  /** Returns true when storage is open. */
  isOpen(): boolean;

  /** Reads persisted committed configuration, or null when absent. */
  read(): Promise<ConfigStorageData | null>;

  /** Persists full committed membership set. */
  write(voters: ClusterMember[], learners: ClusterMember[]): Promise<void>;
}
