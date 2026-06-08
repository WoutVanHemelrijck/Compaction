// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { StorageError } from '../../util/Error';
import { MetaData, MetaStorage } from '../interfaces/MetaStorage';
import { NodeId } from '../../core/Config';

/**
 * In-memory MetaStorage implementation for tests and ephemeral runs.
 */
export class InMemoryMetaStorage implements MetaStorage {
  private data: MetaData | null = null;
  private isOpenFlag = false;

  /** Opens storage handle. */
  async open(): Promise<void> {
    if (this.isOpenFlag) throw new StorageError('InMemoryMetaStorage is already open');
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

  /** Reads current term/vote snapshot. */
  async read(): Promise<MetaData | null> {
    this.ensureOpen();
    await Promise.resolve();
    return this.data ? { ...this.data } : null;
  }

  /** Writes term/vote snapshot. */
  async write(term: number, votedFor: NodeId | null): Promise<void> {
    this.ensureOpen();
    this.data = { term, votedFor };
    await Promise.resolve();
  }

  /** Throws when storage handle is not open. */
  private ensureOpen(): void {
    if (!this.isOpenFlag) throw new StorageError('InMemoryMetaStorage is not open');
  }
}
