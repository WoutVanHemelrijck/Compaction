// @author Tijn Gommers, Mathias Bouhon Keulen
// @date 2025-11-18

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockFile } from './mockfile.mjs';
import random from 'random';

describe('MockFile', () => {
  let file: MockFile;

  beforeEach(() => {
    file = new MockFile(8); // small sector size for testing
  });

  it('should create, write, read and truncate a file', async () => {
    await file.create();
    await file.open();

    const buf = Buffer.from('abcdefgh');
    await file.writev([buf], 0);

    const readBuf = Buffer.alloc(buf.length);
    await file.read(readBuf, { position: 0 });
    expect(readBuf.toString()).toBe('abcdefgh');

    await file.truncate(4);
    const truncatedBuf = Buffer.alloc(4);
    await file.read(truncatedBuf, { position: 0 });
    expect(truncatedBuf.toString()).toBe('abcd');

    const stats = await file.stat();
    expect(stats.size).toBe(4);

    await file.close();
  });

  it('should throw when closing with pending writes', async () => {
    await file.create();
    await file.open();
    await file.writev([Buffer.from('abcd')], 0);

    await expect(file.close()).rejects.toThrow("Closed the file without sync'ing first.");
  });

  it('should sync pending writes correctly', async () => {
    await file.create();
    await file.open();
    await file.writev([Buffer.from('abcdefgh')], 0);

    await file.sync();
    const readBuf = Buffer.alloc(8);
    await file.read(readBuf, { position: 0 });
    expect(readBuf.toString()).toBe('abcdefgh');
  });

  it('should simulate crashBasic correctly', async () => {
    await file.create();
    await file.open();
    await file.writev([Buffer.from('abcdefgh')], 0);

    file.crashBasic();
    const stats = await file.stat();
    expect(stats.size).toBe(8); // size should remain
  });

  it('should simulate crashFullLoss correctly', async () => {
    await file.create();
    await file.open();
    await file.writev([Buffer.from('abcdefgh')], 0);

    file.crashFullLoss();
    const readBuf = Buffer.alloc(8);
    await expect(file.read(readBuf, { position: 0 })).rejects.toThrow(); // nothing saved
  });

  it('should simulate crashPartialCorruption correctly', async () => {
    await file.create();
    await file.open();
    await file.writev([Buffer.from('abcdefgh')], 0);

    file.crashPartialCorruption();
    const readBuf = Buffer.alloc(8);
    await file.read(readBuf, { position: 0 });
    expect(readBuf.toString()).not.toBe('abcdefgh'); // data is corrupted
  });

  it('should simulate crashMixed correctly', async () => {
    await file.create();
    await file.open();
    await file.writev([Buffer.from('abcdefgh')], 0);
    await file.writev([Buffer.from('ijklmnop')], 8);

    file.crashMixed();
    const readBuf = Buffer.alloc(16);
    await file.read(readBuf, { position: 0 }).catch(() => {}); // may fail partially
    expect(readBuf.length).toBe(16);
  });

  it('should maintain file isolation between multiple MockFiles', async () => {
    const file1 = new MockFile(8);
    const file2 = new MockFile(8);

    await file1.create();
    await file2.create();

    await file1.writev([Buffer.from('one')], 0);
    await file2.writev([Buffer.from('two')], 0);

    const buf1 = Buffer.alloc(3);
    const buf2 = Buffer.alloc(3);

    await file1.read(buf1, { position: 0 });
    await file2.read(buf2, { position: 0 });

    expect(buf1.toString()).toBe('one');
    expect(buf2.toString()).toBe('two');
  });

  /*
  it('should throw error when operating on closed file', async () => {
    await file.create();
    await file.open();
    await file.close();

    await expect(file.read(Buffer.alloc(1), { position: 0 })).rejects.toThrow('File is not open.');
    await expect(file.writev([Buffer.from('data')], 0)).rejects.toThrow('File is not open.');
    await expect(file.sync()).rejects.toThrow('File is not open.');
    await expect(file.truncate(0)).rejects.toThrow('File is not open.');
    await expect(file.stat()).rejects.toThrow('File is not open.');
    await expect(file.close()).rejects.toThrow('File is not open.');
  });
  */

  it('full-sector write should be readable immediately', async () => {
    await file.create();
    await file.open();
    const fullSectorBuf = Buffer.from('12345678');
    await file.writev([fullSectorBuf], 0);

    const readBuf = Buffer.alloc(8);
    await file.read(readBuf, { position: 0 });
    expect(readBuf.toString()).toBe('12345678');
    await file.close();
  });

  it('partial pending write should be visible to read before sync', async () => {
    await file.create();
    await file.open();
    const partialBuf = Buffer.from('1234');
    await file.writev([partialBuf], 0);
    const readBuf = Buffer.alloc(4);
    await file.read(readBuf, { position: 0 });
    expect(readBuf.toString()).toBe('1234');

    const stats = await file.stat();
    expect(stats.size).toBe(4);
    await expect(file.close()).rejects.toThrow("Closed the file without sync'ing first.");
  });

  it('read beyondfile bounds should throw', async () => {
    await file.create();
    await file.open();
    await file.writev([Buffer.from('data')], 0);
    const buf = Buffer.alloc(10);
    await expect(file.read(buf, { position: 0 })).rejects.toThrow();
  });

  it('truncate should remove pending writes beyond new length', async () => {
    await file.create();
    await file.open();
    await file.writev([Buffer.from('abcdefgh')], 0);
    await file.writev([Buffer.from('ijklmnop')], 8);

    await file.writev([Buffer.from('qrst')], 16);

    await file.truncate(16);
    const stats = await file.stat();
    expect(stats.size).toBe(16);

    const buf = Buffer.alloc(16);
    await file.read(buf, { position: 0 });

    expect(buf.slice(0, 8).toString()).toBe('abcdefgh');
    expect(buf.slice(8, 16).toString()).toBe('ijklmnop');
  });

  it('splits a long write across multiple sectors (while loop)', async () => {
    await file.create();
    await file.open();

    const payload = Buffer.alloc(20, 'x');
    await file.writev([payload], 3);

    const stats = await file.stat();
    expect(stats.size).toBe(23);

    const readBack = Buffer.alloc(20);
    await file.read(readBack, { position: 3 });
    expect(readBack.equals(payload)).toBe(true);
  });

  it('corrupts pending writes when newSectors is non-empty', async () => {
    await file.create();
    await file.open();

    await file.truncate(8);

    const partial = Buffer.from('abcd');
    const expectedSector = Buffer.alloc(8);
    partial.copy(expectedSector, 0);

    await file.writev([partial], 0);

    const beforeCrash = Buffer.alloc(8);
    await file.read(beforeCrash, { position: 0 });
    expect(beforeCrash.equals(expectedSector)).toBe(true);

    file.crashPartialCorruption();

    const afterCrash = Buffer.alloc(8);
    await file.read(afterCrash, { position: 0 });
    expect(afterCrash.equals(expectedSector)).toBe(false);
  });

  it('skips when the pending writes array is empty (triggers first continue)', async () => {
    await file.create();
    await file.open();

    await file.truncate(8);
    const committed = Buffer.from('AAAAAAAA');
    file['sectors'][0] = Buffer.from(committed);

    file['newSectors'].set(0, []);
    file.crashPartialCorruption();

    expect(file['sectors'][0]).toBeDefined();
    expect(Buffer.from(file['sectors'][0]).equals(committed)).toBe(true);

    expect(file['newSectors'].size).toBe(0);
  });

  it('saves and corrupts the last pending write for a sector, and skips other sectors (deterministic)', async () => {
    await file.create();
    await file.open();

    await file.truncate(16);

    await file.writev([Buffer.from('AAAA')], 0);
    await file.writev([Buffer.from('BBBB')], 0);

    await file.writev([Buffer.from('CCCC')], 8);

    const newSectors = file.getnewSectors();
    expect(newSectors.has(0)).toBe(true);
    expect(newSectors.has(1)).toBe(true);

    const boolSeq = [false, true, true];

    const uniformSeq = [2, 0];
    vi.spyOn(random, 'bool').mockImplementation(() => {
      return boolSeq.shift() ?? false;
    });

    vi.spyOn(random, 'uniformInt').mockImplementation(() => {
      const v = uniformSeq.shift() ?? 0;
      return () => v;
    });

    file.crashMixed();

    expect(file.getnewSectors().size).toBe(0);

    const savedSector0 = Buffer.from(file['sectors'][0]);
    expect(savedSector0).toBeDefined();
    const zeroSector = Buffer.alloc(8);
    expect(savedSector0.equals(zeroSector)).toBe(false);

    const sector1 = Buffer.from(file['sectors'][1]);
    expect(sector1.equals(Buffer.alloc(8))).toBe(true);
  });

  it('saves nothing when nbWritesToSave is zero for a sector', async () => {
    await file.create();
    await file.open();
    await file.truncate(8);
    await file.writev([Buffer.from('DDDD')], 0);

    vi.spyOn(random, 'bool').mockImplementation(() => false);
    vi.spyOn(random, 'uniformInt').mockImplementation(() => {
      return () => 0;
    });

    const before = Buffer.from(file['sectors'][0]);

    file.crashMixed();

    expect(file.getnewSectors().size).toBe(0);

    const after = Buffer.from(file['sectors'][0]);
    expect(after.equals(before)).toBe(true);
  });

  it('crashBasic: saves last pending write for some sectors and skips others', async () => {
    await file.create();
    await file.open();

    await file.truncate(16);

    await file.writev([Buffer.from('aaaa')], 0);
    await file.writev([Buffer.from('bbbb')], 0);
    await file.writev([Buffer.from('cccc')], 8);

    const pendingBefore = new Map<number, Buffer>();
    for (const [k, v] of file['newSectors'].entries()) {
      const last = v.at(-1);
      if (!last) continue;
      pendingBefore.set(Number(k), Buffer.from(last));
    }

    const uniformSeq = [2, 0];
    vi.spyOn(random, 'uniformInt').mockImplementation(() => {
      const v = uniformSeq.shift() ?? 0;
      return () => v;
    });

    file.crashBasic();

    expect(file['newSectors'].size).toBe(0);

    const sector0Saved = file['sectors'][0];
    expect(Buffer.from(sector0Saved).equals(pendingBefore.get(0)!)).toBe(true);

    const sector1 = file['sectors'][1];
    expect(Buffer.from(sector1).equals(Buffer.alloc(8))).toBe(true);
  });

  it('crashMixed: processes some sectors (save +/- corrupt) and skips others based on random.bool', async () => {
    await file.create();
    await file.open();

    await file.truncate(24);

    await file.writev([Buffer.from('1111')], 0);
    await file.writev([Buffer.from('2222')], 0);
    await file.writev([Buffer.from('3333')], 8);
    await file.writev([Buffer.from('4444')], 16);

    const pendingBefore = new Map<number, Buffer>();
    for (const [k, v] of file['newSectors'].entries()) {
      const last = v.at(-1);
      if (!last) continue;
      pendingBefore.set(Number(k), Buffer.from(last));
    }

    const boolSeq = [false, true, true, false, false];
    vi.spyOn(random, 'bool').mockImplementation(() => {
      return boolSeq.shift() ?? false;
    });

    const uniformSeq = [2, 0, 1];
    vi.spyOn(random, 'uniformInt').mockImplementation(() => {
      const v = uniformSeq.shift() ?? 0;
      return () => v;
    });

    file.crashMixed();

    expect(file['newSectors'].size).toBe(0);

    if (pendingBefore.has(0)) {
      const sector0After = Buffer.from(file['sectors'][0]);
      expect(sector0After.equals(pendingBefore.get(0)!)).toBe(false);
    } else {
      throw new Error('Test setup failed: no pending write recorded for sector 0');
    }

    expect(Buffer.from(file['sectors'][1]).equals(Buffer.alloc(8))).toBe(true);

    if (pendingBefore.has(2)) {
      const sector2After = Buffer.from(file['sectors'][2]);
      expect(sector2After.equals(pendingBefore.get(2)!)).toBe(true);
    } else {
      throw new Error('Test setup failed: no pending write recorded for sector 2');
    }
  });
});
