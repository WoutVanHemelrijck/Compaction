// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { SnapshotManager } from './SnapshotManager';
import { InMemorySnapshotStorage } from '../storage/inMemory/InMemorySnapshotStorage';
import { Snapshot } from '../storage/interfaces/SnapshotStorage';
import { StorageError } from '../util/Error';
import { describe, it, expect, beforeEach } from 'vitest';

describe('SnapshotManager.ts, SnapshotManager', () => {
  let snapshotManager: SnapshotManager;
  let snapshotStorage: InMemorySnapshotStorage;

  const snapshot: Snapshot = {
    lastIncludedIndex: 10,
    lastIncludedTerm: 3,
    data: Buffer.from('test data'),
    config: {
      voters: [
        { id: 'node1', address: 'address1' },
        { id: 'node2', address: 'address2' },
      ],
      learners: [],
    },
  };

  beforeEach(async () => {
    snapshotStorage = new InMemorySnapshotStorage();
    await snapshotStorage.open();
    snapshotManager = new SnapshotManager(snapshotStorage);
  });

  it('returns null when no snapshot exists in storage', async () => {
    const result = await snapshotManager.initialize();
    expect(result).toBeNull();
  });

  it('returns snapshot metadata when a snapshot was previously saved', async () => {
    await snapshotStorage.save(snapshot);
    const result = await snapshotManager.initialize();
    expect(result).toEqual({ lastIncludedIndex: 10, lastIncludedTerm: 3 });
  });

  it('does not re-read storage on a second initialize call', async () => {
    await snapshotStorage.save(snapshot);
    await snapshotManager.initialize();
    const result = await snapshotManager.initialize();
    expect(result).toEqual({ lastIncludedIndex: 10, lastIncludedTerm: 3 });
  });

  it('returns null on repeated initialize when no snapshot was found', async () => {
    await snapshotManager.initialize();
    const result = await snapshotManager.initialize();
    expect(result).toBeNull();
  });

  it('throws StorageError if saveSnapshot is called before initialization', async () => {
    await expect(snapshotManager.saveSnapshot(snapshot)).rejects.toThrow(StorageError);
  });

  it('saves a snapshot and updates cached metadata', async () => {
    await snapshotManager.initialize();
    await snapshotManager.saveSnapshot(snapshot);
    expect(snapshotManager.hasSnapshot()).toBe(true);
    expect(snapshotManager.getSnapshotMetadata()).toEqual({
      lastIncludedIndex: snapshot.lastIncludedIndex,
      lastIncludedTerm: snapshot.lastIncludedTerm,
    });
  });

  it('overwrites a previous snapshot', async () => {
    await snapshotManager.initialize();
    await snapshotManager.saveSnapshot(snapshot);
    const newSnapshot: Snapshot = {
      lastIncludedIndex: 20,
      lastIncludedTerm: 5,
      data: Buffer.from('new test data'),
      config: {
        voters: [
          { id: 'node1', address: 'address1' },
          { id: 'node2', address: 'address2' },
        ],
        learners: [],
      },
    };
    await snapshotManager.saveSnapshot(newSnapshot);
    expect(snapshotManager.getSnapshotMetadata()).toEqual({
      lastIncludedIndex: newSnapshot.lastIncludedIndex,
      lastIncludedTerm: newSnapshot.lastIncludedTerm,
    });
  });

  it('throws StorageError if loadSnapshot is called before initialization', async () => {
    await expect(snapshotManager.loadSnapshot()).rejects.toThrow(StorageError);
  });

  it('returns null from loadSnapshot if no snapshot exists', async () => {
    await snapshotManager.initialize();
    const result = await snapshotManager.loadSnapshot();
    expect(result).toBeNull();
  });

  it('returns the full snapshot after saving', async () => {
    await snapshotManager.initialize();
    await snapshotManager.saveSnapshot(snapshot);
    const result = await snapshotManager.loadSnapshot();
    expect(result).toEqual(snapshot);
  });

  it('returns a snapshot that was persisted before initialization', async () => {
    await snapshotStorage.save(snapshot);
    const freshManager = new SnapshotManager(snapshotStorage);
    await freshManager.initialize();
    const result = await freshManager.loadSnapshot();
    expect(result).toEqual(snapshot);
  });

  it('throws StorageError if hasSnapshot is called before initialization', () => {
    expect(() => snapshotManager.hasSnapshot()).toThrow(StorageError);
  });

  it('returns false when no snapshot has been saved', async () => {
    await snapshotManager.initialize();
    expect(snapshotManager.hasSnapshot()).toBe(false);
  });

  it('returns true after a snapshot has been saved', async () => {
    await snapshotManager.initialize();
    await snapshotManager.saveSnapshot(snapshot);
    expect(snapshotManager.hasSnapshot()).toBe(true);
  });

  it('returns true when initialized with existing snapshot data from storage', async () => {
    await snapshotStorage.save(snapshot);
    await snapshotManager.initialize();
    expect(snapshotManager.hasSnapshot()).toBe(true);
  });

  it('throws StorageError if getSnapshotMetadata is called before initialization', () => {
    expect(() => snapshotManager.getSnapshotMetadata()).toThrow(StorageError);
  });

  it('returns null when no snapshot metadata exists', async () => {
    await snapshotManager.initialize();
    expect(snapshotManager.getSnapshotMetadata()).toBeNull();
  });

  it('returns snapshot metadata after a snapshot has been saved', async () => {
    await snapshotManager.initialize();
    await snapshotManager.saveSnapshot(snapshot);
    expect(snapshotManager.getSnapshotMetadata()).toEqual({
      lastIncludedIndex: snapshot.lastIncludedIndex,
      lastIncludedTerm: snapshot.lastIncludedTerm,
    });
  });

  it('returns the latest metadata when multiple snapshots have been saved', async () => {
    await snapshotManager.initialize();
    await snapshotManager.saveSnapshot(snapshot);
    const newSnapshot: Snapshot = {
      lastIncludedIndex: 20,
      lastIncludedTerm: 5,
      data: Buffer.from('new test data'),
      config: {
        voters: [
          { id: 'node1', address: 'address1' },
          { id: 'node2', address: 'address2' },
        ],
        learners: [],
      },
    };
    await snapshotManager.saveSnapshot(newSnapshot);
    expect(snapshotManager.getSnapshotMetadata()).toEqual({
      lastIncludedIndex: newSnapshot.lastIncludedIndex,
      lastIncludedTerm: newSnapshot.lastIncludedTerm,
    });
  });

  it('returns metadata from storage on initialization', async () => {
    await snapshotStorage.save({
      lastIncludedIndex: 15,
      lastIncludedTerm: 4,
      data: Buffer.from('data'),
      config: { voters: [], learners: [] },
    });
    await snapshotManager.initialize();
    expect(snapshotManager.getSnapshotMetadata()).toEqual({ lastIncludedIndex: 15, lastIncludedTerm: 4 });
  });
});
