// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryConfigStorage } from './InMemoryConfigStorage';
import { ClusterMember } from '../../config/ClusterConfig';

describe('InMemoryConfigStorage.ts, InMemoryConfigStorage', () => {
  let storage: InMemoryConfigStorage;

  const voters: ClusterMember[] = [
    { id: 'node1', address: 'address1' },
    { id: 'node2', address: 'address2' },
  ];

  const learners: ClusterMember[] = [{ id: 'node3', address: 'address3' }];

  beforeEach(() => {
    storage = new InMemoryConfigStorage();
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
    await expect(storage.open()).rejects.toThrow('InMemoryConfigStorage is already open');
  });

  it('should close successfully after open', async () => {
    await storage.open();
    await storage.close();
    expect(storage.isOpen()).toBe(false);
  });

  it('should throw when closing while not open', async () => {
    await expect(storage.close()).rejects.toThrow('InMemoryConfigStorage is not open');
  });

  it('should throw when reading while not open', async () => {
    await expect(storage.read()).rejects.toThrow('InMemoryConfigStorage is not open');
  });

  it('should return null when reading before any write', async () => {
    await storage.open();
    await expect(storage.read()).resolves.toBeNull();
  });

  it('should throw when writing while not open', async () => {
    await expect(storage.write(voters, learners)).rejects.toThrow('InMemoryConfigStorage is not open');
  });

  it('should write and read config data', async () => {
    await storage.open();
    await storage.write(voters, learners);

    const data = await storage.read();
    expect(data).toEqual({ voters, learners });
  });

  it('should copy input data on write so later caller mutations do not affect storage', async () => {
    await storage.open();

    const mutableVoters: ClusterMember[] = [{ id: 'node1', address: 'address1' }];
    const mutableLearners: ClusterMember[] = [{ id: 'node2', address: 'address2' }];

    await storage.write(mutableVoters, mutableLearners);

    mutableVoters[0].address = 'changed-address';
    mutableLearners.push({ id: 'node9', address: 'address9' });

    const data = await storage.read();
    expect(data).toEqual({
      voters: [{ id: 'node1', address: 'address1' }],
      learners: [{ id: 'node2', address: 'address2' }],
    });
  });

  it('should return copied arrays on read so caller array mutations do not affect stored data', async () => {
    await storage.open();
    await storage.write(voters, learners);

    const firstRead = await storage.read();
    expect(firstRead).not.toBeNull();

    firstRead!.learners.push({ id: 'node4', address: 'address4' });
    firstRead!.voters = [];

    const secondRead = await storage.read();
    expect(secondRead).toEqual({ voters, learners });
  });
});
