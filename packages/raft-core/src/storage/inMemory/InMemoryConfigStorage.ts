// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { StorageError } from '../../util/Error';
import { ClusterMember } from '../../config/ClusterConfig';
import { ConfigStorage, ConfigStorageData } from '../interfaces/ConfigStorage';

/**
 * In-memory ConfigStorage implementation for tests and ephemeral runs.
 */
export class InMemoryConfigStorage implements ConfigStorage {
  private data: ConfigStorageData | null = null;
  private isOpenFlag = false;

  /** Opens storage handle. */
  async open(): Promise<void> {
    if (this.isOpenFlag) throw new StorageError('InMemoryConfigStorage is already open');
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

  /** Reads current config snapshot, returning deep-cloned members. */
  async read(): Promise<ConfigStorageData | null> {
    this.ensureOpen();
    await Promise.resolve();
    return this.data ? { voters: [...this.data.voters], learners: [...this.data.learners] } : null;
  }

  /** Writes committed config snapshot with copied member objects. */
  async write(voters: ClusterMember[], learners: ClusterMember[]): Promise<void> {
    this.ensureOpen();
    this.data = {
      voters: voters.map((m) => ({ ...m })),
      learners: learners.map((m) => ({ ...m })),
    };
    await Promise.resolve();
  }

  /** Throws when storage handle is not open. */
  private ensureOpen(): void {
    if (!this.isOpenFlag) throw new StorageError('InMemoryConfigStorage is not open');
  }
}
