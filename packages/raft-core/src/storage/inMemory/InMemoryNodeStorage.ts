// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { NodeStorage } from '../interfaces/NodeStorage';
import { InMemoryMetaStorage } from './InMemoryMetaStorage';
import { InMemoryConfigStorage } from './InMemoryConfigStorage';
import { InMemoryLogStorage } from './InMemoryLogStorage';
import { InMemorySnapshotStorage } from './InMemorySnapshotStorage';

/**
 * NodeStorage implementation backed by in-memory sub-storages.
 */
export class InMemoryNodeStorage implements NodeStorage {
  meta: InMemoryMetaStorage;
  config: InMemoryConfigStorage;
  log: InMemoryLogStorage;
  snapshot: InMemorySnapshotStorage;

  constructor() {
    this.meta = new InMemoryMetaStorage();
    this.config = new InMemoryConfigStorage();
    this.log = new InMemoryLogStorage();
    this.snapshot = new InMemorySnapshotStorage();
  }

  /** Opens all in-memory sub-storages if not already open. */
  async open(): Promise<void> {
    if (!this.meta.isOpen()) await this.meta.open();
    if (!this.config.isOpen()) await this.config.open();
    if (!this.log.isOpen()) await this.log.open();
    if (!this.snapshot.isOpen()) await this.snapshot.open();
  }

  /** Closes all in-memory sub-storages that are open. */
  async close(): Promise<void> {
    if (this.meta.isOpen()) await this.meta.close();
    if (this.config.isOpen()) await this.config.close();
    if (this.log.isOpen()) await this.log.close();
    if (this.snapshot.isOpen()) await this.snapshot.close();
  }

  /** Returns true when all in-memory sub-storages are open. */
  isOpen(): boolean {
    return this.meta.isOpen() && this.config.isOpen() && this.log.isOpen() && this.snapshot.isOpen();
  }
}
