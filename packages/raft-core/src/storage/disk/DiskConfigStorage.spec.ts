// @author Mathias Bouhon Keulen
// @date 2026-03-20
import fs from 'fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClusterMember } from '../../config/ClusterConfig';
import { DiskConfigStorage } from './DiskConfigStorage';

function buildConfigBuffer(jsonText: string): Buffer {
  const version = 0x01;
  const headerSize = 9;

  const json = Buffer.from(jsonText, 'utf-8');
  const buf = Buffer.allocUnsafe(headerSize + json.length);

  buf.writeUInt8(version, 0);
  buf.writeUInt32BE(json.length, 5);
  json.copy(buf, 9);

  const crcData = Buffer.concat([buf.subarray(0, 1), buf.subarray(5)]);
  buf.writeUInt32BE(crc32(crcData), 1);

  return buf;
}

describe('DiskConfigStorage.ts, DiskConfigStorage', () => {
  let dirPath: string;

  const voters: ClusterMember[] = [
    { id: 'node1', address: 'address1' },
    { id: 'node2', address: 'address2' },
  ];
  const learners: ClusterMember[] = [{ id: 'node3', address: 'address3' }];

  beforeEach(async () => {
    dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'raft-config-'));
  });

  afterEach(async () => {
    await fs.rm(dirPath, { recursive: true, force: true });
  });

  it('should be closed initially and open/close successfully', async () => {
    const storage = new DiskConfigStorage(dirPath);

    expect(storage.isOpen()).toBe(false);

    await storage.open();
    expect(storage.isOpen()).toBe(true);

    await storage.close();
    expect(storage.isOpen()).toBe(false);
  });

  it('should throw when opening twice', async () => {
    const storage = new DiskConfigStorage(dirPath);
    await storage.open();

    await expect(storage.open()).rejects.toThrow('DiskConfigStorage is already open');
  });

  it('should throw when closing while not open', async () => {
    const storage = new DiskConfigStorage(dirPath);
    await expect(storage.close()).rejects.toThrow('DiskConfigStorage is not open');
  });

  it('should throw when reading while not open', async () => {
    const storage = new DiskConfigStorage(dirPath);
    await expect(storage.read()).rejects.toThrow('DiskConfigStorage is not open');
  });

  it('should throw when writing while not open', async () => {
    const storage = new DiskConfigStorage(dirPath);
    await expect(storage.write(voters, learners)).rejects.toThrow('DiskConfigStorage is not open');
  });

  it('should return null when config.bin does not exist', async () => {
    const storage = new DiskConfigStorage(dirPath);
    await storage.open();

    await expect(storage.read()).resolves.toBeNull();
  });

  it('should write and read config', async () => {
    const storage = new DiskConfigStorage(dirPath);
    await storage.open();

    await storage.write(voters, learners);
    await expect(storage.read()).resolves.toEqual({ voters, learners });
  });

  it('should persist config across reopen', async () => {
    const storage1 = new DiskConfigStorage(dirPath);
    await storage1.open();
    await storage1.write(voters, learners);
    await storage1.close();

    const storage2 = new DiskConfigStorage(dirPath);
    await storage2.open();
    await expect(storage2.read()).resolves.toEqual({ voters, learners });
  });

  it('should recover by promoting config.tmp when only tmp exists', async () => {
    const tmpPath = path.join(dirPath, 'config.tmp');
    const payload = JSON.stringify({ voters, learners });
    await fs.writeFile(tmpPath, buildConfigBuffer(payload));

    const storage = new DiskConfigStorage(dirPath);
    await storage.open();

    await expect(storage.read()).resolves.toEqual({ voters, learners });
  });

  it('should recover by deleting stale config.tmp when both files exist', async () => {
    const filePath = path.join(dirPath, 'config.bin');
    const tmpPath = path.join(dirPath, 'config.tmp');

    await fs.writeFile(filePath, buildConfigBuffer(JSON.stringify({ voters, learners })));
    await fs.writeFile(tmpPath, buildConfigBuffer(JSON.stringify({ voters: [], learners: [] })));

    const storage = new DiskConfigStorage(dirPath);
    await storage.open();

    await expect(storage.read()).resolves.toEqual({ voters, learners });
    await expect(fs.access(tmpPath)).rejects.toBeDefined();
  });

  it('should throw for too-small config.bin', async () => {
    await fs.writeFile(path.join(dirPath, 'config.bin'), Buffer.alloc(3));

    const storage = new DiskConfigStorage(dirPath);
    await storage.open();

    await expect(storage.read()).rejects.toThrow('config.bin too small');
  });

  it('should throw for unsupported version', async () => {
    const buf = buildConfigBuffer(JSON.stringify({ voters, learners }));
    buf.writeUInt8(0x02, 0);
    await fs.writeFile(path.join(dirPath, 'config.bin'), buf);

    const storage = new DiskConfigStorage(dirPath);
    await storage.open();

    await expect(storage.read()).rejects.toThrow('Unsupported config.bin version: 2');
  });

  it('should throw for CRC mismatch', async () => {
    const buf = buildConfigBuffer(JSON.stringify({ voters, learners }));
    buf.writeUInt32BE(0, 1);
    await fs.writeFile(path.join(dirPath, 'config.bin'), buf);

    const storage = new DiskConfigStorage(dirPath);
    await storage.open();

    await expect(storage.read()).rejects.toThrow('config.bin CRC32 mismatch');
  });

  it('should throw for truncated JSON payload', async () => {
    const version = 0x01;
    const headerSize = 9;
    const json = Buffer.from(JSON.stringify({ voters, learners }), 'utf-8');
    const shortened = json.subarray(0, json.length - 2);

    const buf = Buffer.allocUnsafe(headerSize + shortened.length);
    buf.writeUInt8(version, 0);
    buf.writeUInt32BE(json.length, 5);
    shortened.copy(buf, 9);

    const crcData = Buffer.concat([buf.subarray(0, 1), buf.subarray(5)]);
    buf.writeUInt32BE(crc32(crcData), 1);

    await fs.writeFile(path.join(dirPath, 'config.bin'), buf);

    const storage = new DiskConfigStorage(dirPath);
    await storage.open();

    await expect(storage.read()).rejects.toThrow('config.bin truncated: expected');
  });

  it('should throw for JSON parse errors', async () => {
    const invalid = buildConfigBuffer('{');
    await fs.writeFile(path.join(dirPath, 'config.bin'), invalid);

    const storage = new DiskConfigStorage(dirPath);
    await storage.open();

    await expect(storage.read()).rejects.toThrow('config.bin JSON parse error');
  });
});
