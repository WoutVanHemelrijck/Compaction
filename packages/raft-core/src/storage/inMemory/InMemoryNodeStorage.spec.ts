// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryNodeStorage } from './InMemoryNodeStorage';
import { InMemoryMetaStorage } from './InMemoryMetaStorage';
import { InMemoryConfigStorage } from './InMemoryConfigStorage';
import { InMemoryLogStorage } from './InMemoryLogStorage';
import { InMemorySnapshotStorage } from './InMemorySnapshotStorage';

describe('InMemoryNodeStorage.ts, InMemoryNodeStorage', () => {
  let storage: InMemoryNodeStorage;

  beforeEach(() => {
    storage = new InMemoryNodeStorage();
  });

  it('should create all underlying in-memory storages', () => {
    expect(storage.meta).toBeInstanceOf(InMemoryMetaStorage);
    expect(storage.config).toBeInstanceOf(InMemoryConfigStorage);
    expect(storage.log).toBeInstanceOf(InMemoryLogStorage);
    expect(storage.snapshot).toBeInstanceOf(InMemorySnapshotStorage);
  });

  it('should be closed initially', () => {
    expect(storage.isOpen()).toBe(false);
  });

  it('should open all underlying storages', async () => {
    await storage.open();

    expect(storage.meta.isOpen()).toBe(true);
    expect(storage.config.isOpen()).toBe(true);
    expect(storage.log.isOpen()).toBe(true);
    expect(storage.snapshot.isOpen()).toBe(true);
    expect(storage.isOpen()).toBe(true);
  });

  it('should close all underlying storages', async () => {
    await storage.open();
    await storage.close();

    expect(storage.meta.isOpen()).toBe(false);
    expect(storage.config.isOpen()).toBe(false);
    expect(storage.log.isOpen()).toBe(false);
    expect(storage.snapshot.isOpen()).toBe(false);
    expect(storage.isOpen()).toBe(false);
  });

  it('should skip opening already-open underlying storage instances', async () => {
    await storage.meta.open();
    await storage.config.open();

    const metaOpenSpy = vi.spyOn(storage.meta, 'open');
    const configOpenSpy = vi.spyOn(storage.config, 'open');
    const logOpenSpy = vi.spyOn(storage.log, 'open');
    const snapshotOpenSpy = vi.spyOn(storage.snapshot, 'open');

    await storage.open();

    expect(metaOpenSpy).not.toHaveBeenCalled();
    expect(configOpenSpy).not.toHaveBeenCalled();
    expect(logOpenSpy).toHaveBeenCalledTimes(1);
    expect(snapshotOpenSpy).toHaveBeenCalledTimes(1);
    expect(storage.isOpen()).toBe(true);
  });

  it('should skip closing already-closed underlying storage instances', async () => {
    await storage.open();
    await storage.meta.close();
    await storage.log.close();

    const metaCloseSpy = vi.spyOn(storage.meta, 'close');
    const configCloseSpy = vi.spyOn(storage.config, 'close');
    const logCloseSpy = vi.spyOn(storage.log, 'close');
    const snapshotCloseSpy = vi.spyOn(storage.snapshot, 'close');

    await storage.close();

    expect(metaCloseSpy).not.toHaveBeenCalled();
    expect(configCloseSpy).toHaveBeenCalledTimes(1);
    expect(logCloseSpy).not.toHaveBeenCalled();
    expect(snapshotCloseSpy).toHaveBeenCalledTimes(1);
    expect(storage.isOpen()).toBe(false);
  });

  it('should return false from isOpen when at least one underlying storage is closed', async () => {
    await storage.open();
    await storage.snapshot.close();

    expect(storage.meta.isOpen()).toBe(true);
    expect(storage.config.isOpen()).toBe(true);
    expect(storage.log.isOpen()).toBe(true);
    expect(storage.snapshot.isOpen()).toBe(false);
    expect(storage.isOpen()).toBe(false);
  });

  it('should allow repeated open and close calls safely', async () => {
    await expect(storage.open()).resolves.toBeUndefined();
    await expect(storage.open()).resolves.toBeUndefined();

    await expect(storage.close()).resolves.toBeUndefined();
    await expect(storage.close()).resolves.toBeUndefined();

    expect(storage.isOpen()).toBe(false);
  });
});
