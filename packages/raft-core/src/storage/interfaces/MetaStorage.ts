// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { NodeId } from '../../core/Config';

/**
 * Durable Raft metadata payload.
 */
export interface MetaData {
  /** Current persisted term. */
  term: number;
  /** Candidate voted for in current term, or null. */
  votedFor: NodeId | null;
}

/**
 * Storage contract for persistent term/vote state.
 */
export interface MetaStorage {
  /** Opens storage resources. */
  open(): Promise<void>;
  /** Closes storage resources. */
  close(): Promise<void>;
  /** Returns true when storage is open. */
  isOpen(): boolean;

  /** Reads durable term/vote state, or null when uninitialized. */
  read(): Promise<MetaData | null>;

  /** Persists term and vote atomically. */
  write(term: number, votedFor: NodeId | null): Promise<void>;
}
