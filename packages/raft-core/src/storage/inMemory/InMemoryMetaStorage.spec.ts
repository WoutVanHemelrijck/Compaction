// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMetaStorage } from './InMemoryMetaStorage';

describe('InMemoryMetaStorage.ts, InMemoryMetaStorage', () => {
  let storage: InMemoryMetaStorage;

  beforeEach(() => {
    storage = new InMemoryMetaStorage();
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
    await expect(storage.open()).rejects.toThrow('InMemoryMetaStorage is already open');
  });

  it('should close successfully after open', async () => {
    await storage.open();
    await storage.close();
    expect(storage.isOpen()).toBe(false);
  });

  it('should throw when closing while not open', async () => {
    await expect(storage.close()).rejects.toThrow('InMemoryMetaStorage is not open');
  });

  it('should throw when reading while not open', async () => {
    await expect(storage.read()).rejects.toThrow('InMemoryMetaStorage is not open');
  });

  it('should return null when reading before any write', async () => {
    await storage.open();
    await expect(storage.read()).resolves.toBeNull();
  });

  it('should throw when writing while not open', async () => {
    await expect(storage.write(1, 'node1')).rejects.toThrow('InMemoryMetaStorage is not open');
  });

  it('should write and read metadata', async () => {
    await storage.open();
    await storage.write(3, 'node2');

    await expect(storage.read()).resolves.toEqual({ term: 3, votedFor: 'node2' });
  });

  it('should overwrite previously written metadata', async () => {
    await storage.open();
    await storage.write(1, 'node1');
    await storage.write(2, null);

    await expect(storage.read()).resolves.toEqual({ term: 2, votedFor: null });
  });

  it('should return a copy from read', async () => {
    await storage.open();
    await storage.write(7, 'node3');

    const firstRead = await storage.read();
    expect(firstRead).toEqual({ term: 7, votedFor: 'node3' });

    firstRead!.term = 99;
    firstRead!.votedFor = null;

    await expect(storage.read()).resolves.toEqual({ term: 7, votedFor: 'node3' });
  });
});
