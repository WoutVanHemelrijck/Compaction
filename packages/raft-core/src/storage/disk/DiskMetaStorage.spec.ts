// @author Mathias Bouhon Keulen
// @date 2026-03-20
import fs from 'fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiskMetaStorage } from './DiskMetaStorage';

function buildMetaBuffer(term: bigint, votedFor: string | null): Buffer {
  const version = 0x01;
  const fixedSize = 14;

  const votedForBuf = votedFor !== null ? Buffer.from(votedFor, 'utf-8') : null;
  const totalSize = fixedSize + (votedForBuf ? 2 + votedForBuf.length : 0);
  const buf = Buffer.allocUnsafe(totalSize);

  buf.writeUInt8(version, 0);
  buf.writeBigInt64BE(term, 5);
  buf.writeUInt8(votedFor !== null ? 1 : 0, 13);

  if (votedForBuf) {
    buf.writeUInt16BE(votedForBuf.length, 14);
    votedForBuf.copy(buf, 16);
  }

  const crcData = Buffer.concat([buf.subarray(0, 1), buf.subarray(5)]);
  buf.writeUInt32BE(crc32(crcData), 1);

  return buf;
}

describe('DiskMetaStorage.ts, DiskMetaStorage', () => {
  let dirPath: string;

  beforeEach(async () => {
    dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'raft-meta-'));
  });

  afterEach(async () => {
    await fs.rm(dirPath, { recursive: true, force: true });
  });

  it('should be closed initially and open/close successfully', async () => {
    const storage = new DiskMetaStorage(dirPath);

    expect(storage.isOpen()).toBe(false);

    await storage.open();
    expect(storage.isOpen()).toBe(true);

    await storage.close();
    expect(storage.isOpen()).toBe(false);
  });

  it('should throw when opening twice', async () => {
    const storage = new DiskMetaStorage(dirPath);
    await storage.open();

    await expect(storage.open()).rejects.toThrow('DiskMetaStorage is already open');
  });

  it('should throw when closing while not open', async () => {
    const storage = new DiskMetaStorage(dirPath);
    await expect(storage.close()).rejects.toThrow('DiskMetaStorage is not open');
  });

  it('should throw when reading while not open', async () => {
    const storage = new DiskMetaStorage(dirPath);
    await expect(storage.read()).rejects.toThrow('DiskMetaStorage is not open');
  });

  it('should throw when writing while not open', async () => {
    const storage = new DiskMetaStorage(dirPath);
    await expect(storage.write(1, 'node1')).rejects.toThrow('DiskMetaStorage is not open');
  });

  it('should return null when term.bin does not exist', async () => {
    const storage = new DiskMetaStorage(dirPath);
    await storage.open();

    await expect(storage.read()).resolves.toBeNull();
  });

  it('should write and read metadata with votedFor', async () => {
    const storage = new DiskMetaStorage(dirPath);
    await storage.open();

    await storage.write(3, 'node2');
    await expect(storage.read()).resolves.toEqual({ term: 3, votedFor: 'node2' });
  });

  it('should write and read metadata with null votedFor', async () => {
    const storage = new DiskMetaStorage(dirPath);
    await storage.open();

    await storage.write(7, null);
    await expect(storage.read()).resolves.toEqual({ term: 7, votedFor: null });
  });

  it('should persist metadata across reopen', async () => {
    const storage1 = new DiskMetaStorage(dirPath);
    await storage1.open();
    await storage1.write(11, 'node3');
    await storage1.close();

    const storage2 = new DiskMetaStorage(dirPath);
    await storage2.open();
    await expect(storage2.read()).resolves.toEqual({ term: 11, votedFor: 'node3' });
  });

  it('should recover by promoting term.tmp when only tmp exists', async () => {
    const tmpPath = path.join(dirPath, 'term.tmp');
    await fs.writeFile(tmpPath, buildMetaBuffer(BigInt(9), 'node4'));

    const storage = new DiskMetaStorage(dirPath);
    await storage.open();

    await expect(storage.read()).resolves.toEqual({ term: 9, votedFor: 'node4' });
  });

  it('should recover by deleting stale term.tmp when both files exist', async () => {
    const filePath = path.join(dirPath, 'term.bin');
    const tmpPath = path.join(dirPath, 'term.tmp');

    await fs.writeFile(filePath, buildMetaBuffer(BigInt(5), 'nodeA'));
    await fs.writeFile(tmpPath, buildMetaBuffer(BigInt(99), 'nodeB'));

    const storage = new DiskMetaStorage(dirPath);
    await storage.open();

    await expect(storage.read()).resolves.toEqual({ term: 5, votedFor: 'nodeA' });
    await expect(fs.access(tmpPath)).rejects.toBeDefined();
  });

  it('should throw for too-small term.bin', async () => {
    await fs.writeFile(path.join(dirPath, 'term.bin'), Buffer.alloc(1));

    const storage = new DiskMetaStorage(dirPath);
    await storage.open();

    await expect(storage.read()).rejects.toThrow('term.bin too small');
  });

  it('should throw for unsupported version', async () => {
    const buf = buildMetaBuffer(BigInt(1), null);
    buf.writeUInt8(0x02, 0);
    await fs.writeFile(path.join(dirPath, 'term.bin'), buf);

    const storage = new DiskMetaStorage(dirPath);
    await storage.open();

    await expect(storage.read()).rejects.toThrow('Unsupported term.bin version: 2');
  });

  it('should throw for CRC mismatch', async () => {
    const buf = buildMetaBuffer(BigInt(1), null);
    buf[13] = 1;
    await fs.writeFile(path.join(dirPath, 'term.bin'), buf);

    const storage = new DiskMetaStorage(dirPath);
    await storage.open();

    await expect(storage.read()).rejects.toThrow('term.bin CRC32 mismatch');
  });

  it('should throw when votedForLen field is missing', async () => {
    const buf = buildMetaBuffer(BigInt(4), null);
    buf.writeUInt8(1, 13);
    const crcData = Buffer.concat([buf.subarray(0, 1), buf.subarray(5)]);
    buf.writeUInt32BE(crc32(crcData), 1);

    await fs.writeFile(path.join(dirPath, 'term.bin'), buf);

    const storage = new DiskMetaStorage(dirPath);
    await storage.open();

    await expect(storage.read()).rejects.toThrow('term.bin truncated: missing votedForLen field');
  });

  it('should throw when votedFor data is truncated', async () => {
    const buf = Buffer.allocUnsafe(16);
    buf.writeUInt8(0x01, 0);
    buf.writeBigInt64BE(BigInt(4), 5);
    buf.writeUInt8(1, 13);
    buf.writeUInt16BE(3, 14);

    const crcData = Buffer.concat([buf.subarray(0, 1), buf.subarray(5)]);
    buf.writeUInt32BE(crc32(crcData), 1);

    await fs.writeFile(path.join(dirPath, 'term.bin'), buf);

    const storage = new DiskMetaStorage(dirPath);
    await storage.open();

    await expect(storage.read()).rejects.toThrow('term.bin truncated: missing votedFor data');
  });

  it('should throw when term is outside safe integer range', async () => {
    const maxInt64 = (BigInt(1) << BigInt(63)) - BigInt(1);
    await fs.writeFile(path.join(dirPath, 'term.bin'), buildMetaBuffer(maxInt64, null));

    const storage = new DiskMetaStorage(dirPath);
    await storage.open();

    await expect(storage.read()).rejects.toThrow('term is outside JS safe integer range');
  });
});
