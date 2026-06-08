import { describe, it, expect } from 'vitest';
import { FreeBlockFile, NO_BLOCK } from './freeblockfile.mjs';
import { MockFile } from './file/mockfile.mjs';
import type { File as FileInterface } from './file/file.mjs';
import type { AtomicFile } from './freeblockfile.mjs';
import {
  COMPRESSION_ALGORITHM_GZIP_ID,
  COMPRESSION_ENVELOPE_HEADER_SIZE,
  CompressionService,
  FREEBLOCK_COMPRESSED_PAYLOAD_MAGIC,
} from '../durability/compression/compression.mjs';

const DEFAULT_BLOCK_SIZE = 4096;
const NEXT_POINTER_SIZE = 4;
const HEADER_LENGTH_OFFSET = NEXT_POINTER_SIZE;
const HEADER_CLIENT_AREA_OFFSET = HEADER_LENGTH_OFFSET + NEXT_POINTER_SIZE;
const LENGTH_PREFIX_SIZE = 8;

class TestAtomicFile {
  private file: FileInterface;
  private inTransaction = false;
  private stagedWrites: { position: number; buffer: Buffer }[] = [];
  private opened = false;

  constructor(file: FileInterface) {
    this.file = file;
  }

  async open(): Promise<void> {
    if (typeof this.file.open === 'function') await this.file.open();
    this.opened = true;
  }

  async close(): Promise<void> {
    if (typeof this.file.close === 'function') await this.file.close();
    this.opened = false;
  }

  async begin(): Promise<void> {
    if (this.inTransaction) throw new Error('Transaction already in progress.');
    this.inTransaction = true;
    this.stagedWrites = [];
    return Promise.resolve();
  }

  async journalWrite(offset: number, data: Uint8Array): Promise<void> {
    if (!this.inTransaction) throw new Error('No active transaction.');
    this.stagedWrites.push({ position: offset, buffer: Buffer.from(data) });
    return Promise.resolve();
  }

  async commitDataToWal(): Promise<void> {
    if (!this.inTransaction) throw new Error('No active transaction.');
    // No-op for mock; in real implementation this writes to WAL
    return Promise.resolve();
  }

  async checkpoint(): Promise<void> {
    for (const w of this.stagedWrites) {
      await this.file.writev([w.buffer], w.position);
    }
    if (typeof this.file.sync === 'function') await this.file.sync();
    this.stagedWrites = [];
    this.inTransaction = false;
  }

  getOpenAndInTransaction(): boolean {
    return this.inTransaction && this.opened;
  }

  async sync(): Promise<void> {
    if (typeof this.file.sync === 'function') await this.file.sync();
  }
}

async function makeFreeBlockFile() {
  const mf = new MockFile(512);
  const atomic = new TestAtomicFile(mf as unknown as FileInterface);
  const fb = new FreeBlockFile(mf as unknown as FileInterface, atomic as unknown as AtomicFile, DEFAULT_BLOCK_SIZE);
  await fb.open();
  return { fb, mf, atomic };
}

describe('FreeBlockFile', () => {
  it('allocateAndWriteMany should match individual writes for immediate reads', async () => {
    const single = await makeFreeBlockFile();
    const batch = await makeFreeBlockFile();

    const payloads = [
      Buffer.from('doc-a'),
      Buffer.alloc(6000, 0x61),
      Buffer.from(JSON.stringify({ id: 'x3', status: 'active', score: 17 })),
    ];

    const singleStarts: number[] = [];
    for (const payload of payloads) {
      singleStarts.push(await single.fb.allocateAndWrite(payload));
    }

    const batchStarts = await batch.fb.allocateAndWriteMany(payloads);
    expect(batchStarts).toHaveLength(payloads.length);

    for (let i = 0; i < payloads.length; i++) {
      const singleRead = await single.fb.readBlob(singleStarts[i]);
      const batchRead = await batch.fb.readBlob(batchStarts[i]);
      expect(batchRead.equals(singleRead)).toBe(true);
      expect(batchRead.equals(payloads[i])).toBe(true);
    }

    await single.fb.close();
    await batch.fb.close();
  });

  it('allocateAndWriteMany should match individual writes after commit and reopen', async () => {
    const single = await makeFreeBlockFile();
    const batch = await makeFreeBlockFile();

    const payloads = [
      Buffer.from('persist-a'),
      Buffer.alloc(9000, 0x62),
      Buffer.from(JSON.stringify({ id: 'p3', role: 'reader', enabled: true })),
    ];

    const singleStarts: number[] = [];
    for (const payload of payloads) {
      singleStarts.push(await single.fb.allocateAndWrite(payload));
    }
    const batchStarts = await batch.fb.allocateAndWriteMany(payloads);

    await single.fb.commit();
    await batch.fb.commit();
    await single.fb.close();
    await batch.fb.close();

    const singleAtomic2 = new TestAtomicFile(single.mf as unknown as FileInterface);
    const singleFb2 = new FreeBlockFile(
      single.mf as unknown as FileInterface,
      singleAtomic2 as unknown as AtomicFile,
      DEFAULT_BLOCK_SIZE,
    );
    await singleFb2.open();

    const batchAtomic2 = new TestAtomicFile(batch.mf as unknown as FileInterface);
    const batchFb2 = new FreeBlockFile(
      batch.mf as unknown as FileInterface,
      batchAtomic2 as unknown as AtomicFile,
      DEFAULT_BLOCK_SIZE,
    );
    await batchFb2.open();
    await single.fb.checkpoint();
    await batch.fb.checkpoint();

    for (let i = 0; i < payloads.length; i++) {
      const singleRead = await singleFb2.readBlob(singleStarts[i]);
      const batchRead = await batchFb2.readBlob(batchStarts[i]);
      expect(batchRead.equals(singleRead)).toBe(true);
      expect(batchRead.equals(payloads[i])).toBe(true);
    }

    await singleFb2.close();
    await batchFb2.close();
  });

  it('allocateWriteCommitRead', async () => {
    const { fb, mf } = await makeFreeBlockFile();
    const payload = Buffer.from('hello, freeblockfile!');
    const start = await fb.allocateAndWrite(payload);

    await fb.commit();
    await fb.checkpoint();

    const readBack = await fb.readBlob(start);
    expect(readBack.toString()).toEqual(payload.toString());

    await fb.close();

    const atomic2 = new TestAtomicFile(mf as unknown as FileInterface);
    const fb2 = new FreeBlockFile(mf as unknown as FileInterface, atomic2 as unknown as AtomicFile, DEFAULT_BLOCK_SIZE);
    await fb2.open();
    const readBack2 = await fb2.readBlob(start);
    expect(readBack2.toString()).toEqual(payload.toString());
    await fb2.close();
  });

  it('noCommitLosesData', async () => {
    const { fb, mf } = await makeFreeBlockFile();
    const payload = Buffer.from('transient data');
    const start = await fb.allocateAndWrite(payload);

    await fb.close();

    const atomic2 = new TestAtomicFile(mf as unknown as FileInterface);
    const fb2 = new FreeBlockFile(mf as unknown as FileInterface, atomic2 as unknown as AtomicFile, DEFAULT_BLOCK_SIZE);
    await fb2.open();

    const readBack = await fb2.readBlob(start);
    expect(readBack.length).toBe(0);

    await fb2.close();
  });

  it('freeAndReuse', async () => {
    const { fb } = await makeFreeBlockFile();
    const payload = Buffer.from('to be freed');
    const start = await fb.allocateAndWrite(payload);
    await fb.commit();
    await fb.checkpoint();

    const before = await fb.readBlob(start);
    expect(before.toString()).toEqual(payload.toString());

    await fb.freeBlob(start);
    await fb.commit();
    await fb.checkpoint();

    const freeHead = await fb.debug_getFreeListHead();
    expect(freeHead).toEqual(start);

    const newAlloc = await fb.allocateBlocks(1);
    expect(newAlloc).toEqual(start);
    await fb.close();
  });

  it('mixedReuseAndAppend (reuse some freed blocks + append new ones)', async () => {
    const { fb } = await makeFreeBlockFile();

    const payload3 = Buffer.alloc(fb['payloadSize'] * 3 - LENGTH_PREFIX_SIZE, 'a');
    const start3 = await fb.allocateAndWrite(payload3);
    await fb.commit();

    await fb.freeBlob(start3);
    await fb.commit();

    const payload5 = Buffer.alloc(fb['payloadSize'] * 5 - LENGTH_PREFIX_SIZE, 'b');
    const start5 = await fb.allocateAndWrite(payload5);
    await fb.commit();
    await fb.checkpoint();

    const readBack5 = await fb.readBlob(start5);
    expect(readBack5.length).toEqual(payload5.length);
    expect(readBack5.equals(payload5)).toBe(true);

    await fb.close();
  });

  it('stageRawBlock validation', async () => {
    const { fb } = await makeFreeBlockFile();
    const wrong = Buffer.alloc(16);
    await expect(async () => fb.stageRawBlock(2, wrong)).rejects.toThrow('raw block must have blockSize length');
    await fb.close();
  });

  it('constructor should throw for too-small blockSize', () => {
    const mf = new MockFile(512);
    const atomic = new TestAtomicFile(mf as unknown as FileInterface);
    expect(() => new FreeBlockFile(mf as unknown as FileInterface, atomic as unknown as AtomicFile, 16)).toThrow();
  });

  it('methods should throw when called before open', async () => {
    const mf = new MockFile(512);
    const atomic = new TestAtomicFile(mf as unknown as FileInterface);
    const fb = new FreeBlockFile(mf as unknown as FileInterface, atomic as unknown as AtomicFile, DEFAULT_BLOCK_SIZE);
    await expect(fb.allocateBlocks(1)).rejects.toThrow('FreeBlockFile is not open');
    await expect(fb.allocateAndWrite(Buffer.from('x'))).rejects.toThrow('FreeBlockFile is not open');
    await expect(fb.readBlob(1)).rejects.toThrow('FreeBlockFile is not open');
  });

  it('allocateBlocks should throw for non-positive count', async () => {
    const { fb } = await makeFreeBlockFile();
    await expect(fb.allocateBlocks(0)).rejects.toThrow('count must be positive');
    await expect(fb.allocateBlocks(-1)).rejects.toThrow('count must be positive');
    await fb.close();
  });

  it('writeHeader should throw if header too large and readHeader/writeHeader behavior', async () => {
    const { fb, mf } = await makeFreeBlockFile();

    const maxClientHeader = fb['blockSize'] - HEADER_CLIENT_AREA_OFFSET;
    await expect(fb.writeHeader(Buffer.alloc(maxClientHeader + 1))).rejects.toThrow('header too large');

    const hdr = Buffer.from('my-metadata');
    await fb.writeHeader(hdr);
    const r1 = await fb.readHeader();
    expect(r1.toString()).toEqual(hdr.toString());

    await fb.commit();
    await fb.checkpoint();
    await fb.close();

    const atomic2 = new TestAtomicFile(mf as unknown as FileInterface);
    const fb2 = new FreeBlockFile(mf as unknown as FileInterface, atomic2 as unknown as AtomicFile, DEFAULT_BLOCK_SIZE);
    await fb2.open();
    await fb2.checkpoint();
    const r2 = await fb2.readHeader();
    expect(r2.toString()).toEqual(hdr.toString());
    await fb2.close();
  });

  it('stageRawBlock should update cached header/freeList when staging block 0', async () => {
    const { fb, mf } = await makeFreeBlockFile();

    const b = Buffer.alloc(fb['blockSize'], 0);
    const wantFreeHead = 7;
    const clientHdr = Buffer.from('xyz');
    b.writeUInt32LE(wantFreeHead >>> 0, 0);
    b.writeUInt32LE(clientHdr.length >>> 0, HEADER_LENGTH_OFFSET);
    clientHdr.copy(b, HEADER_CLIENT_AREA_OFFSET);

    await fb.stageRawBlock(0, b);

    const gotHead = await fb.debug_getFreeListHead();
    expect(gotHead).toEqual(wantFreeHead);

    const gotHdr = await fb.readHeader();
    expect(gotHdr.toString()).toEqual(clientHdr.toString());

    await fb.commit();
    await fb.close();

    const atomic2 = new TestAtomicFile(mf as unknown as FileInterface);
    const fb2 = new FreeBlockFile(mf as unknown as FileInterface, atomic2 as unknown as AtomicFile, DEFAULT_BLOCK_SIZE);
    await fb2.open();
    await fb2.checkpoint();
    const gotHead2 = await fb2.debug_getFreeListHead();
    expect(gotHead2).toEqual(wantFreeHead);
    const gotHdr2 = await fb2.readHeader();
    expect(gotHdr2.toString()).toEqual(clientHdr.toString());
    await fb2.close();
  });

  it('freeBlob(NO_BLOCK) is a no-op and readBlob(NO_BLOCK) returns empty', async () => {
    const { fb } = await makeFreeBlockFile();
    await expect(fb.freeBlob(NO_BLOCK)).resolves.not.toThrow();
    const empty = await fb.readBlob(NO_BLOCK);
    expect(empty.length).toEqual(0);
    await fb.close();
  });

  it('commit should throw when called before open (ensureOpened)', async () => {
    const mf = new MockFile(512);
    const atomic = new TestAtomicFile(mf as unknown as FileInterface);
    const fb = new FreeBlockFile(mf as unknown as FileInterface, atomic as unknown as AtomicFile, DEFAULT_BLOCK_SIZE);
    await expect(fb.commit()).rejects.toThrow('FreeBlockFile is not open');
  });

  it('commit is a no-op when there are no staged writes (early return)', async () => {
    const { fb, mf } = await makeFreeBlockFile();

    await fb.commit();
    const st1 = await mf.stat();

    await fb.commit();
    const st2 = await mf.stat();

    expect(st2.size).toEqual(st1.size);

    await fb.close();
  });

  it('commit auto-stages header if missing from stagedWrites', async () => {
    const { fb, mf } = await makeFreeBlockFile();

    await fb.commit();

    const b1 = Buffer.alloc(fb['blockSize'], 0);
    b1.writeUInt32LE(0xdeadbeef >>> 0, 0);

    await fb.stageRawBlock(1, b1);

    const stBefore = await mf.stat();
    expect(stBefore.size).toBeLessThanOrEqual(fb['blockSize']);

    await fb.commit();
    await fb.checkpoint();

    const stAfter = await mf.stat();
    expect(stAfter.size).toBeGreaterThanOrEqual(fb['blockSize'] * 2);

    const headerBlock = Buffer.alloc(fb['blockSize']);
    await mf.read(headerBlock, { position: 0 });
    const headFromFile = headerBlock.readUInt32LE(0);
    const headCached = await fb.debug_getFreeListHead();
    expect(headFromFile).toEqual(headCached);

    const readBlock1 = Buffer.alloc(fb['blockSize']);
    await mf.read(readBlock1, { position: fb['blockSize'] });
    expect(readBlock1.equals(b1)).toBe(true);

    await fb.close();
  });
  it('readHeader returns empty Buffer when no header written yet', async () => {
    const { fb } = await makeFreeBlockFile();
    const hdr = await fb.readHeader();
    expect(hdr.length).toEqual(0);
    await fb.close();
  });

  it('readBlob returns empty when length prefix is zero', async () => {
    const { fb } = await makeFreeBlockFile();

    const b = Buffer.alloc(fb['blockSize'], 0);
    b.writeUInt32LE(NO_BLOCK >>> 0, 0);
    b.writeBigUInt64LE(0n, NEXT_POINTER_SIZE);
    await fb.stageRawBlock(10, b);

    const out = await fb.readBlob(10);
    expect(out.length).toEqual(0);

    await fb.close();
  });

  it('readBlob correctly decodes length-prefixed data from staged block', async () => {
    const { fb } = await makeFreeBlockFile();

    const data = Buffer.from('this-is-data');
    const full = Buffer.alloc(LENGTH_PREFIX_SIZE + data.length);
    full.writeBigUInt64LE(BigInt(data.length), 0);
    data.copy(full, LENGTH_PREFIX_SIZE);

    const b = Buffer.alloc(fb['blockSize'], 0);
    b.writeUInt32LE(NO_BLOCK >>> 0, 0);
    full.copy(b, NEXT_POINTER_SIZE);

    await fb.stageRawBlock(11, b);

    const out = await fb.readBlob(11);
    expect(out.equals(data)).toBe(true);

    await fb.close();
  });

  it('readBlob on out-of-range block returns empty via readRawBlock zero-buffer branch', async () => {
    const { fb, mf } = await makeFreeBlockFile();

    await fb.commit();
    const st = await mf.stat();
    expect(st.size).toBeGreaterThanOrEqual(0);

    const out = await fb.readBlob(99);
    expect(out.length).toEqual(0);

    await fb.close();
  });

  it('reads legacy freeblock compressed envelope payload', async () => {
    const { fb } = await makeFreeBlockFile();
    const service = new CompressionService({ algorithm: 'gzip' });

    const original = Buffer.from('legacy-freeblock-payload', 'utf-8');
    const compressed = service.compress(original);

    const metadata = Buffer.alloc(COMPRESSION_ENVELOPE_HEADER_SIZE);
    FREEBLOCK_COMPRESSED_PAYLOAD_MAGIC.copy(metadata, 0);
    metadata.writeUInt8(COMPRESSION_ALGORITHM_GZIP_ID, 4);
    metadata.writeUInt32LE(compressed.originalSize, 5);
    metadata.writeUInt32LE(compressed.compressedSize, 9);
    const encoded = Buffer.concat([metadata, compressed.payload]);

    const start = await fb.allocateAndWrite(encoded);
    await fb.commit();
    await fb.checkpoint();

    const out = await fb.readBlob(start);
    expect(out.equals(original)).toBe(true);

    await fb.close();
  });
});
