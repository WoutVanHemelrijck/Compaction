// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySnapshotStorage } from './InMemorySnapshotStorage';
import { Snapshot } from '../interfaces/SnapshotStorage';

describe('InMemorySnapshotStorage.ts, InMemorySnapshotStorage', () => {
  let storage: InMemorySnapshotStorage;

  const baseSnapshot: Snapshot = {
    lastIncludedIndex: 5,
    lastIncludedTerm: 2,
    data: Buffer.from('snapshot-bytes'),
    config: {
      voters: [
        { id: 'node1', address: 'address1' },
        { id: 'node2', address: 'address2' },
      ],
      learners: [{ id: 'node3', address: 'address3' }],
    },
  };

  beforeEach(() => {
    storage = new InMemorySnapshotStorage();
  });

  it('should be closed initially', () => {
    expect(storage.isOpen()).toBe(false);
  });

  it('should open successfully', async () => {
    await storage.open();
    expect(storage.isOpen()).toBe(true);
  });

  it('should throw when opening twice', async () => {
    await storage.open();
    await expect(storage.open()).rejects.toThrow('InMemorySnapshotStorage is already open');
  });

  it('should close successfully after open', async () => {
    await storage.open();
    await storage.close();
    expect(storage.isOpen()).toBe(false);
  });

  it('should throw when closing while not open', async () => {
    await expect(storage.close()).rejects.toThrow('InMemorySnapshotStorage is not open');
  });

  it('should throw when reading metadata while not open', async () => {
    await expect(storage.readMetadata()).rejects.toThrow('InMemorySnapshotStorage is not open');
  });

  it('should throw when saving while not open', async () => {
    await expect(storage.save(baseSnapshot)).rejects.toThrow('InMemorySnapshotStorage is not open');
  });

  it('should throw when loading while not open', async () => {
    await expect(storage.load()).rejects.toThrow('InMemorySnapshotStorage is not open');
  });

  it('should return null metadata and null snapshot before any save', async () => {
    await storage.open();
    await expect(storage.readMetadata()).resolves.toBeNull();
    await expect(storage.load()).resolves.toBeNull();
  });

  it('should save snapshot and read metadata', async () => {
    await storage.open();
    await storage.save(baseSnapshot);

    await expect(storage.readMetadata()).resolves.toEqual({
      lastIncludedIndex: 5,
      lastIncludedTerm: 2,
    });
  });

  it('should load a deep copy of saved snapshot', async () => {
    await storage.open();
    await storage.save(baseSnapshot);

    const loaded = await storage.load();
    expect(loaded).toEqual(baseSnapshot);
    expect(loaded).not.toBeNull();

    loaded!.data[0] = 'X'.charCodeAt(0);
    loaded!.config.voters[0].address = 'changed-address';
    loaded!.config.learners.push({ id: 'node9', address: 'address9' });

    const loadedAgain = await storage.load();
    expect(loadedAgain).toEqual(baseSnapshot);
  });

  it('should overwrite previously saved snapshot', async () => {
    await storage.open();
    await storage.save(baseSnapshot);

    const newer: Snapshot = {
      lastIncludedIndex: 9,
      lastIncludedTerm: 3,
      data: Buffer.from('newer-bytes'),
      config: {
        voters: [{ id: 'node1', address: 'address1' }],
        learners: [],
      },
    };

    await storage.save(newer);

    await expect(storage.readMetadata()).resolves.toEqual({
      lastIncludedIndex: 9,
      lastIncludedTerm: 3,
    });
    await expect(storage.load()).resolves.toEqual(newer);
  });
});
