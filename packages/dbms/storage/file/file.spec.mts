// @author Tijn Gommers
// @date 2025-11-18

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { RealFile } from './file.mjs';
import path from 'node:path';

const TEST_DIR = './test_files';

export async function cleanupTestDir(): Promise<void> {
  try {
    // Verwijder de directory en alles erin, als het bestaat
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  } catch (err) {
    console.error(`Failed to remove test directory: ${(err as Error).message}`);
  }

  try {
    // remake a directory
    await fs.mkdir(TEST_DIR, { recursive: true });
  } catch (err) {
    console.error(`Failed to create test directory: ${(err as Error).message}`);
    throw err;
  }
}

describe('RealFile', () => {
  beforeEach(async () => {
    await cleanupTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir();
  });

  it('should create, open, write, read and truncate a file', async () => {
    const filePath = path.join(TEST_DIR, 'test1.txt');
    const file = new RealFile(filePath);

    await file.create();
    expect(file.isOpen()).toBe(true);

    const bufferToWrite = Buffer.from('Hello, RealFile!');
    await file.writev([bufferToWrite], 0);

    const readBuffer = Buffer.alloc(bufferToWrite.length);
    await file.read(readBuffer, { position: 0 });
    expect(readBuffer.toString()).toBe('Hello, RealFile!');

    await file.truncate(5);
    const truncatedBuffer = Buffer.alloc(5);
    await file.read(truncatedBuffer, { position: 0 });
    expect(truncatedBuffer.toString()).toBe('Hello');

    const stats = await file.stat();
    expect(stats.size).toBe(5);

    await file.close();
    expect(file.isOpen()).toBe(false);
  });

  it('should check existence and delete a file', async () => {
    const filePath = path.join(TEST_DIR, 'test2.txt');
    const file = new RealFile(filePath);

    expect(await file.exists()).toBe(false);

    await file.create();
    expect(await file.exists()).toBe(true);

    await file.close();
    await file.delete();
    expect(await file.exists()).toBe(false);
  });

  it('should throw if deleting an open file', async () => {
    const filePath = path.join(TEST_DIR, 'test3.txt');
    const file = new RealFile(filePath);

    await file.create();
    await expect(file.delete()).rejects.toThrow('Cannot delete an open file.');
  });

  it('should maintain file isolation between two instances', async () => {
    const filePath1 = path.join(TEST_DIR, 'file1.txt');
    const filePath2 = path.join(TEST_DIR, 'file2.txt');

    const file1 = new RealFile(filePath1);
    const file2 = new RealFile(filePath2);

    await file1.create();
    await file2.create();

    await file1.writev([Buffer.from('one')], 0);
    await file2.writev([Buffer.from('two')], 0);

    const buffer1 = Buffer.alloc(3);
    const buffer2 = Buffer.alloc(3);

    await file1.read(buffer1, { position: 0 });
    await file2.read(buffer2, { position: 0 });

    expect(buffer1.toString()).toBe('one');
    expect(buffer2.toString()).toBe('two');

    await file1.close();
    await file2.close();
  });

  it('should throw when reading from a closed file', async () => {
    const filePath = path.join(TEST_DIR, 'test4.txt');
    const file = new RealFile(filePath);
    await file.create();
    await file.close();

    const buffer = Buffer.alloc(10);
    await expect(file.read(buffer, { position: 0 })).rejects.toThrow('File is not open.');
  });

  it('should throw when writing to a closed file', async () => {
    const filePath = path.join(TEST_DIR, 'test5.txt');
    const file = new RealFile(filePath);
    await file.create();
    await file.close();

    await expect(file.writev([Buffer.from('data')], 0)).rejects.toThrow('File is not open.');
  });

  it('should throw when opening an already open file', async () => {
    const filePath = path.join(TEST_DIR, 'test6.txt');
    const file = new RealFile(filePath);
    await file.create();
    await expect(file.open()).rejects.toThrow('File is already open.');
    await file.close();
  });

  it('should throw when creating an already open file', async () => {
    const filePath = path.join(TEST_DIR, 'test7.txt');
    const file = new RealFile(filePath);
    await file.create();
    await expect(file.create()).rejects.toThrow('File is already open.');
    await file.close();
  });

  it('should throw when closing an already closed file', async () => {
    const filePath = path.join(TEST_DIR, 'test8.txt');
    const file = new RealFile(filePath);
    await file.create();
    await file.close();
    await expect(file.close()).rejects.toThrow('File is not open.');
  });

  it('should throw when syncing a closed file', async () => {
    const filePath = path.join(TEST_DIR, 'test9.txt');
    const file = new RealFile(filePath);
    await file.create();
    await file.close();
    await expect(file.sync()).rejects.toThrow('File is not open.');
  });

  it('should throw when truncating a closed file', async () => {
    const filePath = path.join(TEST_DIR, 'test10.txt');
    const file = new RealFile(filePath);
    await file.create();
    await file.close();
    await expect(file.truncate(10)).rejects.toThrow('File is not open.');
  });

  it('should throw when getting stats of a closed file', async () => {
    const filePath = path.join(TEST_DIR, 'test11.txt');
    const file = new RealFile(filePath);
    await file.create();
    await file.close();
    await expect(file.stat()).rejects.toThrow('File is not open.');
  });
});
