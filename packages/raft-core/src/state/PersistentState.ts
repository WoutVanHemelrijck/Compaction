// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { NodeId } from '../core/Config';
import { MetaStorage } from '../storage/interfaces/MetaStorage';
import { PersistentStateError, StorageError } from '../util/Error';

/**
 * Point-in-time view of durable Raft state for initialization return and testing.
 */
export interface PersistentStateSnapshot {
  /** Current term restored from storage. */
  currentTerm: number;
  /** Node voted for in currentTerm, or null. */
  votedFor: NodeId | null;
}

/**
 * Contract for durable Raft state that must survive node restarts.
 */
export interface PersistentStateInterface {
  initialize(): Promise<PersistentStateSnapshot>;
  getCurrentTerm(): number;
  getVotedFor(): NodeId | null;
  setCurrentTerm(term: number): Promise<void>;
  updateTermAndVote(term: number, votedFor: NodeId | null): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Storage-backed Raft persistent state holding current term and vote grant.
 *
 * @remarks
 * Both fields must be written durably before responding to any RPC to preserve
 * the Raft safety guarantees across crashes.
 */
export class PersistentState implements PersistentStateInterface {
  private currentTerm: number = 0;
  private votedFor: NodeId | null = null;
  private initialized: boolean = false;

  constructor(private readonly meta: MetaStorage) {}

  /**
   * Restores term and vote from persistent storage.
   *
   * @returns Restored snapshot of term and vote state.
   * @throws PersistentStateError When storage is not open.
   */
  async initialize(): Promise<PersistentStateSnapshot> {
    if (this.initialized) {
      return {
        currentTerm: this.currentTerm,
        votedFor: this.votedFor,
      };
    }

    if (!this.meta.isOpen()) {
      throw new PersistentStateError('Storage must be open before initializing PersistentState');
    }

    const snapshot = await this.restore();
    this.currentTerm = snapshot.currentTerm;
    this.votedFor = snapshot.votedFor;
    this.initialized = true;
    return snapshot;
  }

  /** Returns the current persisted term. */
  getCurrentTerm(): number {
    this.ensureInitialized();
    return this.currentTerm;
  }

  /** Returns the node this node voted for in the current term, or null. */
  getVotedFor(): NodeId | null {
    this.ensureInitialized();
    return this.votedFor;
  }

  /**
   * Persists a new term and clears the vote grant.
   *
   * @param term New term value, must be >= current term.
   */
  async setCurrentTerm(term: number): Promise<void> {
    await this.updateTermAndVote(term, null);
  }

  /**
   * Atomically persists term and vote in a single storage write.
   *
   * @param term New term value, must be >= current term.
   * @param votedFor Candidate voted for in this term, or null.
   * @throws PersistentStateError When term is invalid or storage write fails.
   */
  async updateTermAndVote(term: number, votedFor: NodeId | null): Promise<void> {
    this.ensureInitialized();

    this.assertValidNewTerm(term);

    if (term === this.currentTerm && votedFor === this.votedFor) {
      return;
    }

    try {
      await this.meta.write(term, votedFor);
      this.currentTerm = term;
      this.votedFor = votedFor;
    } catch (error) {
      throw new PersistentStateError(
        'Failed to update term and vote',
        error instanceof StorageError ? error : undefined,
      );
    }
  }

  /**
   * Resets term to 0 and clears vote grant in storage.
   *
   * @throws PersistentStateError When storage write fails.
   */
  async clear(): Promise<void> {
    this.ensureInitialized();

    try {
      await this.meta.write(0, null);
      this.currentTerm = 0;
      this.votedFor = null;
    } catch (error) {
      throw new PersistentStateError(
        'Failed to clear persistent state',
        error instanceof StorageError ? error : undefined,
      );
    }
  }

  /** Throws if initialize() has not been called. */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new PersistentStateError('PersistentState must be initialized before use');
    }
  }

  /** Reads stored term and vote, returning defaults when storage is empty. */
  private async restore(): Promise<PersistentStateSnapshot> {
    try {
      const data = await this.meta.read();

      if (data) {
        this.validateTerm(data.term);
        this.currentTerm = data.term;
        this.votedFor = data.votedFor;
      }

      return {
        currentTerm: this.currentTerm,
        votedFor: this.votedFor,
      };
    } catch (error) {
      throw new PersistentStateError('Failed to restore persistent state', error as StorageError);
    }
  }

  /** Validates that a term value is a non-negative integer. */
  private validateTerm(term: number): void {
    if (!Number.isInteger(term) || term < 0) {
      throw new PersistentStateError(`Invalid term value in storage: ${term}`);
    }
  }

  /** Asserts that a new term is valid and not a regression. */
  private assertValidNewTerm(newTerm: number): void {
    this.validateTerm(newTerm);

    if (newTerm < this.currentTerm) {
      throw new PersistentStateError(
        `New term ${newTerm} must be greater than or equal to current term ${this.currentTerm}`,
      );
    }
  }
}
