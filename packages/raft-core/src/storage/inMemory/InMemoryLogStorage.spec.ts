// @author Mathias Bouhon Keulen
// @date 2026-03-20
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryLogStorage } from './InMemoryLogStorage';
import { LogEntry, LogEntryType } from '../../log/LogEntry';

describe('InMemoryLogStorage.ts, InMemoryLogStorage', () => {
  let storage: InMemoryLogStorage;

  const e1: LogEntry = {
    index: 1,
    term: 1,
    type: LogEntryType.COMMAND,
    command: { type: 'set', payload: { key: 'a', value: 1 } },
  };
  const e2: LogEntry = {
    index: 2,
    term: 1,
    type: LogEntryType.COMMAND,
    command: { type: 'set', payload: { key: 'b', value: 2 } },
  };
  const e3: LogEntry = {
    index: 3,
    term: 2,
    type: LogEntryType.COMMAND,
    command: { type: 'set', payload: { key: 'c', value: 3 } },
  };
  const e4: LogEntry = {
    index: 4,
    term: 2,
    type: LogEntryType.COMMAND,
    command: { type: 'set', payload: { key: 'd', value: 4 } },
  };

  beforeEach(() => {
    storage = new InMemoryLogStorage();
  });

  it('should be closed initially', () => {
    expect(storage.isOpen()).toBe(false);
  });

  it('should open and close successfully', async () => {
    await storage.open();
    expect(storage.isOpen()).toBe(true);

    await storage.close();
    expect(storage.isOpen()).toBe(false);
  });

  it('should throw when opening twice', async () => {
    await storage.open();
    await expect(storage.open()).rejects.toThrow('InMemoryLogStorage is already open');
  });

  it('should throw when using methods while closed', async () => {
    await expect(storage.readMeta()).rejects.toThrow('InMemoryLogStorage is not open');
    await expect(storage.append([e1])).rejects.toThrow('InMemoryLogStorage is not open');
    await expect(storage.getEntry(1)).rejects.toThrow('InMemoryLogStorage is not open');
    await expect(storage.getEntries(1, 1)).rejects.toThrow('InMemoryLogStorage is not open');
    await expect(storage.truncateFrom(1)).rejects.toThrow('InMemoryLogStorage is not open');
    await expect(storage.compact(1, 1)).rejects.toThrow('InMemoryLogStorage is not open');
    await expect(storage.reset(1, 1)).rejects.toThrow('InMemoryLogStorage is not open');
    await expect(storage.close()).rejects.toThrow('InMemoryLogStorage is not open');
  });

  it('should read initial meta after open', async () => {
    await storage.open();
    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 0,
      snapshotTerm: 0,
      lastIndex: 0,
      lastTerm: 0,
    });
  });

  it('should ignore append with empty entries', async () => {
    await storage.open();
    await storage.append([]);

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 0,
      snapshotTerm: 0,
      lastIndex: 0,
      lastTerm: 0,
    });
  });

  it('should append entries and update last index and term', async () => {
    await storage.open();
    await storage.append([e1, e2, e3]);

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 0,
      snapshotTerm: 0,
      lastIndex: 3,
      lastTerm: 2,
    });
  });

  it('should get entry and return null for out-of-range values', async () => {
    await storage.open();
    await storage.append([e1, e2]);

    await expect(storage.getEntry(1)).resolves.toEqual(e1);
    await expect(storage.getEntry(3)).resolves.toBeNull();

    await storage.compact(1, 1);
    await expect(storage.getEntry(1)).resolves.toBeNull();
  });

  it('should get range of entries and throw when missing an entry', async () => {
    await storage.open();
    await storage.append([e1, e2, e3]);

    await expect(storage.getEntries(1, 3)).resolves.toEqual([e1, e2, e3]);

    await storage.truncateFrom(2);
    await storage.append([e4]);

    await expect(storage.getEntries(1, 4)).rejects.toThrow('Missing log entry at index 2');
  });

  it('should return null from getEntry when index is in range but entry is missing', async () => {
    await storage.open();
    await storage.append([e1, e2, e3]);

    await storage.truncateFrom(2);
    await storage.append([e4]);

    await expect(storage.getEntry(3)).resolves.toBeNull();
  });

  it('should throw in getEntries when requesting compacted index', async () => {
    await storage.open();
    await storage.append([e1, e2]);
    await storage.compact(1, 1);

    await expect(storage.getEntries(1, 2)).rejects.toThrow('Missing log entry at index 1');
  });

  it('should truncate and set last index and term from previous entry', async () => {
    await storage.open();
    await storage.append([e1, e2, e3, e4]);

    await storage.truncateFrom(3);

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 0,
      snapshotTerm: 0,
      lastIndex: 2,
      lastTerm: 1,
    });

    await expect(storage.getEntry(3)).resolves.toBeNull();
  });

  it('should truncate to snapshot values when truncation reaches snapshot boundary', async () => {
    await storage.open();
    await storage.append([e1, e2, e3]);
    await storage.compact(2, 1);

    await storage.truncateFrom(2);

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 2,
      snapshotTerm: 1,
      lastIndex: 2,
      lastTerm: 1,
    });
  });

  it('should set lastTerm to 0 when truncating and previous entry is missing', async () => {
    await storage.open();

    const sparse: LogEntry = {
      index: 4,
      term: 7,
      type: LogEntryType.COMMAND,
      command: { type: 'set', payload: { key: 'x', value: 1 } },
    };
    await storage.append([sparse]);

    await storage.truncateFrom(4);

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 0,
      snapshotTerm: 0,
      lastIndex: 3,
      lastTerm: 0,
    });
  });

  it('should compact without changing last index when compact point is below last index', async () => {
    await storage.open();
    await storage.append([e1, e2, e3, e4]);

    await storage.compact(2, 1);

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 2,
      snapshotTerm: 1,
      lastIndex: 4,
      lastTerm: 2,
    });

    await expect(storage.getEntry(2)).resolves.toBeNull();
    await expect(storage.getEntry(3)).resolves.toEqual(e3);
  });

  it('should compact and move last index and term when compact point is at or beyond last index', async () => {
    await storage.open();
    await storage.append([e1, e2]);

    await storage.compact(5, 3);

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 5,
      snapshotTerm: 3,
      lastIndex: 5,
      lastTerm: 3,
    });

    await expect(storage.getEntry(5)).resolves.toBeNull();
  });

  it('should reset to snapshot and clear previous entries', async () => {
    await storage.open();
    await storage.append([e1, e2, e3]);

    await storage.reset(10, 4);

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 10,
      snapshotTerm: 4,
      lastIndex: 10,
      lastTerm: 4,
    });

    await expect(storage.getEntry(3)).resolves.toBeNull();
    await expect(storage.getEntries(11, 11)).rejects.toThrow('Missing log entry at index 11');
  });
});
