// @author Mathias Bouhon Keulen
// @date 2026-03-20
import fs from 'fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LogEntry, LogEntryType } from '../../log/LogEntry';
import { DiskLogStorage } from './DiskLogStorage';

const WAL_HEADER_SIZE = 21;

function buildHeader(snapshotIndex: bigint, snapshotTerm: bigint, version = 0x01, magic = 'RWAL'): Buffer {
  const buf = Buffer.allocUnsafe(WAL_HEADER_SIZE);
  Buffer.from(magic).copy(buf, 0);
  buf.writeUInt8(version, 4);
  buf.writeBigInt64BE(snapshotIndex, 5);
  buf.writeBigInt64BE(snapshotTerm, 13);
  return buf;
}

function buildRecord(entry: LogEntry, options?: { corruptCrc?: boolean }): Buffer {
  const payload = Buffer.from(JSON.stringify(entry), 'utf-8');

  const crcData = Buffer.allocUnsafe(21 + payload.length);
  crcData.writeUInt32BE(payload.length, 0);
  crcData.writeBigInt64BE(BigInt(entry.index), 4);
  crcData.writeBigInt64BE(BigInt(entry.term), 12);
  crcData.writeUInt8(entry.type === LogEntryType.CONFIG ? 1 : 0, 20);
  payload.copy(crcData, 21);

  let checksum = crc32(crcData);
  if (options?.corruptCrc) checksum = 0;

  const record = Buffer.allocUnsafe(4 + crcData.length);
  record.writeUInt32BE(checksum, 0);
  crcData.copy(record, 4);

  return record;
}

describe('DiskLogStorage.ts, DiskLogStorage', () => {
  let dirPath: string;

  const entry1: LogEntry = {
    index: 1,
    term: 1,
    type: LogEntryType.COMMAND,
    command: { type: 'set', payload: { key: 'a', value: 1 } },
  };

  const entry2: LogEntry = {
    index: 2,
    term: 1,
    type: LogEntryType.CONFIG,
    config: {
      voters: [
        { id: 'node1', address: 'address1' },
        { id: 'node2', address: 'address2' },
      ],
      learners: [],
    },
  };

  const entry3: LogEntry = {
    index: 3,
    term: 2,
    type: LogEntryType.NOOP,
  };

  beforeEach(async () => {
    dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'raft-disk-log-'));
  });

  afterEach(async () => {
    await fs.rm(dirPath, { recursive: true, force: true });
  });

  it('should open/close and report state', async () => {
    const storage = new DiskLogStorage(dirPath);

    expect(storage.isOpen()).toBe(false);

    await storage.open();
    expect(storage.isOpen()).toBe(true);

    await storage.close();
    expect(storage.isOpen()).toBe(false);
  });

  it('should throw on open twice', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();

    await expect(storage.open()).rejects.toThrow('DiskLogStorage is already open');
  });

  it('should throw when operations are called while closed', async () => {
    const storage = new DiskLogStorage(dirPath);

    await expect(storage.close()).rejects.toThrow('DiskLogStorage is not open');
    await expect(storage.readMeta()).rejects.toThrow('DiskLogStorage is not open');
    await expect(storage.append([entry1])).rejects.toThrow('DiskLogStorage is not open');
    await expect(storage.getEntry(1)).rejects.toThrow('DiskLogStorage is not open');
    await expect(storage.getEntries(1, 1)).rejects.toThrow('DiskLogStorage is not open');
    await expect(storage.truncateFrom(1)).rejects.toThrow('DiskLogStorage is not open');
    await expect(storage.compact(1, 1)).rejects.toThrow('DiskLogStorage is not open');
    await expect(storage.reset(1, 1)).rejects.toThrow('DiskLogStorage is not open');
  });

  it('should initialize empty metadata when wal file does not exist', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 0,
      snapshotTerm: 0,
      lastIndex: 0,
      lastTerm: 0,
    });
  });

  it('should append entries and read them back', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();

    await storage.append([entry1, entry2, entry3]);

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 0,
      snapshotTerm: 0,
      lastIndex: 3,
      lastTerm: 2,
    });
    await expect(storage.getEntry(1)).resolves.toEqual(entry1);
    await expect(storage.getEntry(2)).resolves.toEqual(entry2);
    await expect(storage.getEntry(3)).resolves.toEqual(entry3);
    await expect(storage.getEntries(1, 3)).resolves.toEqual([entry1, entry2, entry3]);
  });

  it('should no-op append on empty list', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();

    await storage.append([]);

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 0,
      snapshotTerm: 0,
      lastIndex: 0,
      lastTerm: 0,
    });
  });

  it('should append to existing WAL', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();

    await storage.append([entry1]);
    await storage.append([entry2]);

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 0,
      snapshotTerm: 0,
      lastIndex: 2,
      lastTerm: 1,
    });
    await expect(storage.getEntries(1, 2)).resolves.toEqual([entry1, entry2]);
  });

  it('should return null for missing index and throw on missing range entry', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();

    await storage.append([entry1]);

    await expect(storage.getEntry(2)).resolves.toBeNull();
    await expect(storage.getEntries(1, 2)).rejects.toThrow('Missing log entry at index 2');
  });

  it('should persist entries across reopen', async () => {
    const storage1 = new DiskLogStorage(dirPath);
    await storage1.open();
    await storage1.append([entry1, entry2]);
    await storage1.close();

    const storage2 = new DiskLogStorage(dirPath);
    await storage2.open();

    await expect(storage2.getEntries(1, 2)).resolves.toEqual([entry1, entry2]);
  });

  it('should truncate from index and update metadata', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();
    await storage.append([entry1, entry2, entry3]);

    await storage.truncateFrom(3);

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 0,
      snapshotTerm: 0,
      lastIndex: 2,
      lastTerm: 1,
    });
    await expect(storage.getEntry(3)).resolves.toBeNull();
  });

  it('should throw when truncating from unknown index', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();
    await storage.append([entry1]);

    await expect(storage.truncateFrom(2)).rejects.toThrow('Cannot truncate: index 2 not in WAL');
  });

  it('should set last index and term to snapshot when truncating to snapshot boundary', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();
    await storage.reset(5, 2);

    const e6: LogEntry = { index: 6, term: 2, type: LogEntryType.NOOP };
    const e7: LogEntry = { index: 7, term: 2, type: LogEntryType.NOOP };
    await storage.append([e6, e7]);

    await storage.truncateFrom(6);

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 5,
      snapshotTerm: 2,
      lastIndex: 5,
      lastTerm: 2,
    });
  });

  it('should set lastTerm to 0 when truncating sparse log and previous entry is missing', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();

    const sparse: LogEntry = {
      index: 4,
      term: 9,
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

  it('should compact and keep entries above compact index', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();
    await storage.append([entry1, entry2, entry3]);

    await storage.compact(1, 1);

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 1,
      snapshotTerm: 1,
      lastIndex: 3,
      lastTerm: 2,
    });
    await expect(storage.getEntry(1)).resolves.toBeNull();
    await expect(storage.getEntries(2, 3)).resolves.toEqual([entry2, entry3]);
  });

  it('should skip missing entries while collecting records during compact', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();

    const sparse4: LogEntry = {
      index: 4,
      term: 2,
      type: LogEntryType.COMMAND,
      command: { type: 'set', payload: { key: 's4', value: 4 } },
    };
    const sparse6: LogEntry = {
      index: 6,
      term: 3,
      type: LogEntryType.COMMAND,
      command: { type: 'set', payload: { key: 's6', value: 6 } },
    };

    await storage.append([sparse4, sparse6]);
    await storage.compact(3, 1);

    await expect(storage.getEntry(4)).resolves.toEqual(sparse4);
    await expect(storage.getEntry(5)).resolves.toBeNull();
    await expect(storage.getEntry(6)).resolves.toEqual(sparse6);
  });

  it('should compact to header only when no entries remain', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();
    await storage.append([entry1, entry2]);

    await storage.compact(2, 1);

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 2,
      snapshotTerm: 1,
      lastIndex: 2,
      lastTerm: 1,
    });
    await expect(storage.getEntry(2)).resolves.toBeNull();
  });

  it('should reset wal to snapshot header', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();
    await storage.append([entry1, entry2]);

    await storage.reset(10, 4);

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 10,
      snapshotTerm: 4,
      lastIndex: 10,
      lastTerm: 4,
    });
    await expect(storage.getEntry(1)).resolves.toBeNull();
  });

  it('should recover by promoting wal.tmp when wal.bin is missing', async () => {
    const tmpWalPath = path.join(dirPath, 'wal.tmp');
    const walBuf = Buffer.concat([buildHeader(BigInt(0), BigInt(0)), buildRecord(entry1)]);
    await fs.writeFile(tmpWalPath, walBuf);

    const storage = new DiskLogStorage(dirPath);
    await storage.open();

    await expect(storage.getEntry(1)).resolves.toEqual(entry1);
  });

  it('should recover by deleting stale wal.tmp when wal.bin exists', async () => {
    const walPath = path.join(dirPath, 'wal.bin');
    const tmpWalPath = path.join(dirPath, 'wal.tmp');

    await fs.writeFile(walPath, Buffer.concat([buildHeader(BigInt(0), BigInt(0)), buildRecord(entry1)]));
    await fs.writeFile(tmpWalPath, Buffer.concat([buildHeader(BigInt(0), BigInt(0)), buildRecord(entry2)]));

    const storage = new DiskLogStorage(dirPath);
    await storage.open();

    await expect(storage.getEntry(1)).resolves.toEqual(entry1);
    await expect(fs.access(tmpWalPath)).rejects.toBeDefined();
  });

  it('should throw when wal header is too small', async () => {
    await fs.writeFile(path.join(dirPath, 'wal.bin'), Buffer.alloc(3));

    const storage = new DiskLogStorage(dirPath);
    await expect(storage.open()).rejects.toThrow('wal.bin too small to contain header');
  });

  it('should throw for parseHeader when provided buffer is smaller than header size', () => {
    const storage = new DiskLogStorage(dirPath);
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
    expect(() => (storage as any).parseHeader(Buffer.alloc(1))).toThrow('wal.bin too small: 1 bytes');
  });

  it('should throw when wal header has invalid magic', async () => {
    await fs.writeFile(path.join(dirPath, 'wal.bin'), buildHeader(BigInt(0), BigInt(0), 0x01, 'XXXX'));

    const storage = new DiskLogStorage(dirPath);
    await expect(storage.open()).rejects.toThrow('wal.bin invalid magic bytes');
  });

  it('should throw when wal header has unsupported version', async () => {
    await fs.writeFile(path.join(dirPath, 'wal.bin'), buildHeader(BigInt(0), BigInt(0), 0x02));

    const storage = new DiskLogStorage(dirPath);
    await expect(storage.open()).rejects.toThrow('Unsupported wal.bin version: 2');
  });

  it('should throw when wal snapshot header values are outside safe integer range', async () => {
    const maxInt64 = (BigInt(1) << BigInt(63)) - BigInt(1);
    await fs.writeFile(path.join(dirPath, 'wal.bin'), buildHeader(maxInt64, BigInt(0)));

    const storage = new DiskLogStorage(dirPath);
    await expect(storage.open()).rejects.toThrow('wal snapshotIndex is outside JS safe integer range');
  });

  it('should truncate trailing partial record during open scan', async () => {
    const good = buildRecord(entry1);
    const wal = Buffer.concat([buildHeader(BigInt(0), BigInt(0)), good, Buffer.from([0x01, 0x02, 0x03])]);
    const walPath = path.join(dirPath, 'wal.bin');
    await fs.writeFile(walPath, wal);

    const storage = new DiskLogStorage(dirPath);
    await storage.open();

    const stat = await fs.stat(walPath);
    expect(stat.size).toBe(WAL_HEADER_SIZE + good.length);
    await expect(storage.getEntry(1)).resolves.toEqual(entry1);
  });

  it('should truncate trailing record when scan reads full prefix but partial rest', async () => {
    const rec1 = buildRecord(entry1);
    const partialPrefixOnly = rec1.subarray(0, 8);
    const walPath = path.join(dirPath, 'wal.bin');
    await fs.writeFile(walPath, Buffer.concat([buildHeader(BigInt(0), BigInt(0)), partialPrefixOnly]));

    const storage = new DiskLogStorage(dirPath);
    await storage.open();

    const stat = await fs.stat(walPath);
    expect(stat.size).toBe(WAL_HEADER_SIZE);
  });

  it('should ignore scanned records at or below snapshot index', async () => {
    const snapshotHeader = buildHeader(BigInt(5), BigInt(2));
    const atSnapshot: LogEntry = {
      index: 5,
      term: 2,
      type: LogEntryType.NOOP,
    };
    const walPath = path.join(dirPath, 'wal.bin');
    await fs.writeFile(walPath, Buffer.concat([snapshotHeader, buildRecord(atSnapshot)]));

    const storage = new DiskLogStorage(dirPath);
    await storage.open();

    await expect(storage.readMeta()).resolves.toEqual({
      snapshotIndex: 5,
      snapshotTerm: 2,
      lastIndex: 5,
      lastTerm: 2,
    });
    await expect(storage.getEntry(5)).resolves.toBeNull();
  });

  it('should truncate from first bad CRC record during open scan', async () => {
    const rec1 = buildRecord(entry1);
    const rec2 = buildRecord(entry2, { corruptCrc: true });
    const walPath = path.join(dirPath, 'wal.bin');
    await fs.writeFile(walPath, Buffer.concat([buildHeader(BigInt(0), BigInt(0)), rec1, rec2]));

    const storage = new DiskLogStorage(dirPath);
    await storage.open();

    await expect(storage.getEntry(1)).resolves.toEqual(entry1);
    await expect(storage.getEntry(2)).resolves.toBeNull();

    const stat = await fs.stat(walPath);
    expect(stat.size).toBe(WAL_HEADER_SIZE + rec1.length);
  });

  it('should detect truncated record on getEntry', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();
    await storage.append([entry1]);

    const walPath = path.join(dirPath, 'wal.bin');
    await fs.truncate(walPath, WAL_HEADER_SIZE + 4);

    await expect(storage.getEntry(1)).rejects.toThrow('Truncated record at offset');
  });

  it('should detect truncated record when getEntry reads full prefix but partial rest', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();
    await storage.append([entry1]);

    const walPath = path.join(dirPath, 'wal.bin');
    const full = await fs.readFile(walPath);
    const truncated = full.subarray(0, full.length - 1);
    await fs.writeFile(walPath, truncated);

    await expect(storage.getEntry(1)).rejects.toThrow('Truncated record at offset');
  });

  it('should detect CRC mismatch on getEntry', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();
    await storage.append([entry1]);

    const walPath = path.join(dirPath, 'wal.bin');
    const buf = await fs.readFile(walPath);
    buf[WAL_HEADER_SIZE + 10] = buf[WAL_HEADER_SIZE + 10] ^ 0xff;
    await fs.writeFile(walPath, buf);

    await expect(storage.getEntry(1)).rejects.toThrow('WAL CRC32 mismatch at offset');
  });

  it('should reject unsafe integers in append entries and in compact/reset headers', async () => {
    const storage = new DiskLogStorage(dirPath);
    await storage.open();

    const badIndex: LogEntry = {
      index: Number.MAX_SAFE_INTEGER + 1,
      term: 1,
      type: LogEntryType.NOOP,
    };

    const badTerm: LogEntry = {
      index: 1,
      term: Number.MAX_SAFE_INTEGER + 1,
      type: LogEntryType.NOOP,
    };

    await expect(storage.append([badIndex])).rejects.toThrow('entry.index must be a safe integer');
    await expect(storage.append([badTerm])).rejects.toThrow('entry.term must be a safe integer');
    await expect(storage.compact(Number.MAX_SAFE_INTEGER + 1, 1)).rejects.toThrow(
      'snapshotIndex must be a safe integer',
    );
    await expect(storage.reset(1, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow('snapshotTerm must be a safe integer');
  });
});
