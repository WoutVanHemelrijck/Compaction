// @author Mathias Bouhon Keulen
// @date 2026-03-20
import fs from 'fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Snapshot } from '../interfaces/SnapshotStorage';
import { DiskSnapshotStorage } from './DiskSnapshotStorage';

function buildSnapshotBuffer(
  lastIncludedIndex: bigint,
  lastIncludedTerm: bigint,
  configJsonText: string,
  data: Buffer,
  declaredConfigLength?: number,
  declaredDataLength?: number,
): Buffer {
  const version = 0x01;
  const configBuf = Buffer.from(configJsonText, 'utf-8');
  const configLen = declaredConfigLength ?? configBuf.length;
  const dataLen = declaredDataLength ?? data.length;

  const totalSize = 1 + 4 + 8 + 8 + 4 + configBuf.length + 4 + data.length;
  const buf = Buffer.allocUnsafe(totalSize);

  let pos = 0;
  buf.writeUInt8(version, pos);
  pos += 1;
  pos += 4;
  buf.writeBigInt64BE(lastIncludedIndex, pos);
  pos += 8;
  buf.writeBigInt64BE(lastIncludedTerm, pos);
  pos += 8;
  buf.writeUInt32BE(configLen, pos);
  pos += 4;
  configBuf.copy(buf, pos);
  pos += configBuf.length;
  buf.writeUInt32BE(dataLen, pos);
  pos += 4;
  data.copy(buf, pos);

  const crcData = Buffer.concat([buf.subarray(0, 1), buf.subarray(5)]);
  buf.writeUInt32BE(crc32(crcData), 1);

  return buf;
}

describe('DiskSnapshotStorage.ts, DiskSnapshotStorage', () => {
  let dirPath: string;

  const snapshot: Snapshot = {
    lastIncludedIndex: 8,
    lastIncludedTerm: 3,
    data: Buffer.from('snapshot-data'),
    config: {
      voters: [
        { id: 'node1', address: 'address1' },
        { id: 'node2', address: 'address2' },
      ],
      learners: [{ id: 'node3', address: 'address3' }],
    },
  };

  beforeEach(async () => {
    dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'raft-snapshot-'));
  });

  afterEach(async () => {
    await fs.rm(dirPath, { recursive: true, force: true });
  });

  it('should be closed initially and open/close successfully', async () => {
    const storage = new DiskSnapshotStorage(dirPath);

    expect(storage.isOpen()).toBe(false);

    await storage.open();
    expect(storage.isOpen()).toBe(true);

    await storage.close();
    expect(storage.isOpen()).toBe(false);
  });

  it('should throw when opening twice', async () => {
    const storage = new DiskSnapshotStorage(dirPath);
    await storage.open();

    await expect(storage.open()).rejects.toThrow('DiskSnapshotStorage is already open');
  });

  it('should throw when closing while not open', async () => {
    const storage = new DiskSnapshotStorage(dirPath);
    await expect(storage.close()).rejects.toThrow('DiskSnapshotStorage is not open');
  });

  it('should throw when readMetadata while not open', async () => {
    const storage = new DiskSnapshotStorage(dirPath);
    await expect(storage.readMetadata()).rejects.toThrow('DiskSnapshotStorage is not open');
  });

  it('should throw when save while not open', async () => {
    const storage = new DiskSnapshotStorage(dirPath);
    await expect(storage.save(snapshot)).rejects.toThrow('DiskSnapshotStorage is not open');
  });

  it('should throw when load while not open', async () => {
    const storage = new DiskSnapshotStorage(dirPath);
    await expect(storage.load()).rejects.toThrow('DiskSnapshotStorage is not open');
  });

  it('should return null when snapshot file does not exist', async () => {
    const storage = new DiskSnapshotStorage(dirPath);
    await storage.open();

    await expect(storage.load()).resolves.toBeNull();
    await expect(storage.readMetadata()).resolves.toBeNull();
  });

  it('should save, load and read metadata', async () => {
    const storage = new DiskSnapshotStorage(dirPath);
    await storage.open();

    await storage.save(snapshot);

    await expect(storage.readMetadata()).resolves.toEqual({
      lastIncludedIndex: 8,
      lastIncludedTerm: 3,
    });
    await expect(storage.load()).resolves.toEqual(snapshot);
  });

  it('should persist snapshot across reopen', async () => {
    const s1 = new DiskSnapshotStorage(dirPath);
    await s1.open();
    await s1.save(snapshot);
    await s1.close();

    const s2 = new DiskSnapshotStorage(dirPath);
    await s2.open();
    await expect(s2.load()).resolves.toEqual(snapshot);
  });

  it('should recover by promoting snapshot.tmp when only tmp exists', async () => {
    const tmpPath = path.join(dirPath, 'snapshot.tmp');
    await fs.writeFile(
      tmpPath,
      buildSnapshotBuffer(
        BigInt(snapshot.lastIncludedIndex),
        BigInt(snapshot.lastIncludedTerm),
        JSON.stringify(snapshot.config),
        snapshot.data,
      ),
    );

    const storage = new DiskSnapshotStorage(dirPath);
    await storage.open();

    await expect(storage.load()).resolves.toEqual(snapshot);
  });

  it('should recover by deleting stale snapshot.tmp when both files exist', async () => {
    const filePath = path.join(dirPath, 'snapshot.bin');
    const tmpPath = path.join(dirPath, 'snapshot.tmp');

    const older = {
      ...snapshot,
      lastIncludedIndex: 4,
      lastIncludedTerm: 1,
      data: Buffer.from('older'),
    };

    await fs.writeFile(
      filePath,
      buildSnapshotBuffer(
        BigInt(older.lastIncludedIndex),
        BigInt(older.lastIncludedTerm),
        JSON.stringify(older.config),
        older.data,
      ),
    );
    await fs.writeFile(
      tmpPath,
      buildSnapshotBuffer(
        BigInt(snapshot.lastIncludedIndex),
        BigInt(snapshot.lastIncludedTerm),
        JSON.stringify(snapshot.config),
        snapshot.data,
      ),
    );

    const storage = new DiskSnapshotStorage(dirPath);
    await storage.open();

    await expect(storage.load()).resolves.toEqual(older);
    await expect(fs.access(tmpPath)).rejects.toBeDefined();
  });

  it('should throw when save receives unsafe lastIncludedIndex', async () => {
    const storage = new DiskSnapshotStorage(dirPath);
    await storage.open();

    const invalid = {
      ...snapshot,
      lastIncludedIndex: Number.MAX_SAFE_INTEGER + 1,
    };

    await expect(storage.save(invalid)).rejects.toThrow('snapshot.lastIncludedIndex must be a safe integer');
  });

  it('should throw when save receives unsafe lastIncludedTerm', async () => {
    const storage = new DiskSnapshotStorage(dirPath);
    await storage.open();

    const invalid = {
      ...snapshot,
      lastIncludedTerm: Number.MAX_SAFE_INTEGER + 1,
    };

    await expect(storage.save(invalid)).rejects.toThrow('snapshot.lastIncludedTerm must be a safe integer');
  });

  it('should throw for too-small snapshot.bin', async () => {
    await fs.writeFile(path.join(dirPath, 'snapshot.bin'), Buffer.alloc(10));

    const storage = new DiskSnapshotStorage(dirPath);
    await storage.open();

    await expect(storage.load()).rejects.toThrow('snapshot.bin too small');
  });

  it('should throw for unsupported snapshot version', async () => {
    const buf = buildSnapshotBuffer(BigInt(1), BigInt(1), JSON.stringify(snapshot.config), snapshot.data);
    buf.writeUInt8(0x02, 0);
    await fs.writeFile(path.join(dirPath, 'snapshot.bin'), buf);

    const storage = new DiskSnapshotStorage(dirPath);
    await storage.open();

    await expect(storage.load()).rejects.toThrow('Unsupported snapshot.bin version: 2');
  });

  it('should throw for CRC mismatch', async () => {
    const buf = buildSnapshotBuffer(BigInt(1), BigInt(1), JSON.stringify(snapshot.config), snapshot.data);
    buf.writeUInt32BE(0, 1);
    await fs.writeFile(path.join(dirPath, 'snapshot.bin'), buf);

    const storage = new DiskSnapshotStorage(dirPath);
    await storage.open();

    await expect(storage.load()).rejects.toThrow('snapshot.bin CRC32 mismatch');
  });

  it('should throw when snapshot lastIncludedIndex is outside JS safe integer range', async () => {
    const maxInt64 = (BigInt(1) << BigInt(63)) - BigInt(1);
    const buf = buildSnapshotBuffer(maxInt64, BigInt(1), JSON.stringify(snapshot.config), snapshot.data);
    await fs.writeFile(path.join(dirPath, 'snapshot.bin'), buf);

    const storage = new DiskSnapshotStorage(dirPath);
    await storage.open();

    await expect(storage.load()).rejects.toThrow('snapshot lastIncludedIndex is outside JS safe integer range');
  });

  it('should throw when snapshot lastIncludedTerm is outside JS safe integer range', async () => {
    const maxInt64 = (BigInt(1) << BigInt(63)) - BigInt(1);
    const buf = buildSnapshotBuffer(BigInt(1), maxInt64, JSON.stringify(snapshot.config), snapshot.data);
    await fs.writeFile(path.join(dirPath, 'snapshot.bin'), buf);

    const storage = new DiskSnapshotStorage(dirPath);
    await storage.open();

    await expect(storage.load()).rejects.toThrow('snapshot lastIncludedTerm is outside JS safe integer range');
  });

  it('should throw for truncation in config section', async () => {
    const configJson = JSON.stringify(snapshot.config);
    const data = Buffer.alloc(0);
    const buf = buildSnapshotBuffer(BigInt(1), BigInt(1), configJson, data, configJson.length + 10, 0);
    await fs.writeFile(path.join(dirPath, 'snapshot.bin'), buf);

    const storage = new DiskSnapshotStorage(dirPath);
    await storage.open();

    await expect(storage.load()).rejects.toThrow('snapshot.bin truncated in config section');
  });

  it('should throw for config JSON parse errors', async () => {
    const invalidConfig = '{';
    const buf = buildSnapshotBuffer(BigInt(1), BigInt(1), invalidConfig, Buffer.from('x'));
    await fs.writeFile(path.join(dirPath, 'snapshot.bin'), buf);

    const storage = new DiskSnapshotStorage(dirPath);
    await storage.open();

    await expect(storage.load()).rejects.toThrow('snapshot.bin config JSON error');
  });

  it('should throw for truncation in data section', async () => {
    const configJson = JSON.stringify(snapshot.config);
    const data = Buffer.from('abc');
    const buf = buildSnapshotBuffer(BigInt(1), BigInt(1), configJson, data, configJson.length, data.length + 2);
    await fs.writeFile(path.join(dirPath, 'snapshot.bin'), buf);

    const storage = new DiskSnapshotStorage(dirPath);
    await storage.open();

    await expect(storage.load()).rejects.toThrow('snapshot.bin truncated in data section');
  });
});
