// @author Mathias Bouhon Keulen
// @date 2025-11-11

// =============================================================
// FreeBlockFile — Block-Based File Manager with Free List
// =============================================================
//
// This module implements a fixed-size block allocator on top of a file.
// Blocks are either used or part of a free list chain. Block 0 is reserved
// for metadata (header + free list head pointer).
//
// File Layout (each block = blockSize bytes):
//
// ┌────────────┬────────────────────────────┐
// │ Block 0    │ Header Block               │
// │            │ ┌────────────────────────┐ │
// │            │ │ uint32 freeListHead    │ │ offset 0
// │            │ │ uint32 headerLength    │ │ offset 4
// │            │ │ client header bytes... │ │ offset 8+
// │            │ └────────────────────────┘ │
// ├────────────┼────────────────────────────┤
// │ Block 1..n │ Data or free blocks        │
// │            │ ┌────────────────────────┐ │
// │            │ │ uint32 nextPtr         │ │ offset 0
// │            │ │ payload bytes...       │ │ offset 4+
// │            │ └────────────────────────┘ │
// └────────────┴────────────────────────────┘
//
// Free blocks are linked via their first 4 bytes (nextPtr).
// The file grows automatically when no free blocks remain.
//
// =============================================================

import { type File } from '../storage/file/file.mjs';
import {
  COMPRESSION_ENVELOPE_HEADER_SIZE,
  CompressionService,
  FREEBLOCK_COMPRESSED_PAYLOAD_MAGIC,
  resolveCompressionAlgorithmFromEnvironment,
} from '../durability/compression/compression.mjs';
import { deserializeCompressionEnvelope, serializeCompressionEnvelope } from '../durability/compression/envelope.mjs';
import { debug_incrementDiskReadCount, debug_incrementWriteCounts } from '../core/debug-global-constants.mjs';
import type { AtomicFile } from '../durability/atomic-operations/atomic-file.mjs';
export type { AtomicFile } from '../durability/atomic-operations/atomic-file.mjs';

/**
 * default block size used by FreeBlockFile if none is specified.
 */
export const DEFAULT_BLOCK_SIZE = 4096;

/**
 * Size in bytes of the "next block" pointer at the start of each block.
 */
export const NEXT_POINTER_SIZE = 4;

/**
 * Offset of the free list head pointer in block 0.
 */
export const FREE_LIST_HEAD_OFFSET = 0;

/**
 * Offset of the header length field in block 0.
 */
export const HEADER_LENGTH_OFFSET = FREE_LIST_HEAD_OFFSET + NEXT_POINTER_SIZE;

/**
 * Offset of the client header area in block 0.
 */
export const HEADER_CLIENT_AREA_OFFSET = HEADER_LENGTH_OFFSET + NEXT_POINTER_SIZE;

/**
 * Size in bytes of the length prefix for blobs.
 */
export const LENGTH_PREFIX_SIZE = 8;

/**
 * Constant indicating "no block".
 */
export const NO_BLOCK = 0;

/**
 * Minimum allowed block size for FreeBlockFile.
 */
export const MIN_BLOCK_SIZE = HEADER_CLIENT_AREA_OFFSET + 16;

/**
 * A file abstraction that manages fixed-size blocks with a free-list for reuse.
 */
export class FreeBlockFile {
  readonly blockSize: number;
  readonly payloadSize: number;

  private file: File;
  private atomicFile: AtomicFile;

  private stagedWrites: Map<number, Buffer> = new Map();

  private stagedBatchWrites: Array<{ startBlockId: number; blockCount: number; buffer: Buffer }> = [];

  private pendingFrees: number[] = [];

  private cachedFreeListHead: number = NO_BLOCK;
  private cachedHeaderBuf: Buffer = Buffer.alloc(0);

  private opened = false;
  private static readonly NODE_MIN_SAVED_BYTES = 64;
  private static readonly NODE_MIN_COMPRESS_SIZE_BYTES = 512;
  private readonly compressionService = new CompressionService({
    algorithm: resolveCompressionAlgorithmFromEnvironment(),
    minSizeBytes: FreeBlockFile.NODE_MIN_COMPRESS_SIZE_BYTES,
  });

  private ensureOpened(): void {
    if (!this.opened) throw new Error('FreeBlockFile is not open');
  }

  /**
   * Construct a FreeBlockFile instance.
   * @param {File} file - The underlying file to use.
   * @param {AtomicFile} atomicFile - The atomic file operations interface.
   * @param {number} blockSize - The size of each block in bytes.
   * @throws {Error} If the block size is smaller than the minimum allowed size.
   */
  constructor(file: File, atomicFile: AtomicFile, blockSize = DEFAULT_BLOCK_SIZE) {
    if (blockSize < MIN_BLOCK_SIZE) {
      throw new Error(`blockSize too small; must be >= ${MIN_BLOCK_SIZE}`);
    }
    this.file = file;
    this.atomicFile = atomicFile;
    this.blockSize = blockSize;
    this.payloadSize = blockSize - NEXT_POINTER_SIZE;
  }

  /**
   * Open the FreeBlockFile, initializing or loading the header and free list.
   */
  async open(): Promise<void> {
    if (this.atomicFile.open) {
      await this.atomicFile.open();
    } else {
      await this.file.open();
    }

    const st = await this.file.stat();
    if (st.size === 0) {
      this.cachedFreeListHead = NO_BLOCK;
      this.cachedHeaderBuf = Buffer.alloc(0);
      this.stageHeaderBlock();
    } else {
      const headerBlock = Buffer.alloc(this.blockSize);
      await this.file.read(headerBlock, { position: 0 });
      this.cachedFreeListHead = headerBlock.readUInt32LE(FREE_LIST_HEAD_OFFSET);
      const headerLen = headerBlock.readUInt32LE(HEADER_LENGTH_OFFSET);
      if (headerLen > 0) {
        this.cachedHeaderBuf = Buffer.from(
          headerBlock.slice(HEADER_CLIENT_AREA_OFFSET, HEADER_CLIENT_AREA_OFFSET + headerLen),
        );
      } else {
        this.cachedHeaderBuf = Buffer.alloc(0);
      }
    }

    this.opened = true;
  }

  /**
   * Close the FreeBlockFile, flushing any pending changes.
   */
  async close(): Promise<void> {
    if (this.atomicFile.close) {
      await this.atomicFile.close();
    } else {
      await this.file.close();
    }
    this.opened = false;
  }

  /**
   * Read the header data from block 0.
   */
  async readHeader(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(this.cachedHeaderBuf));
  }

  /**
   * Write the header data to block 0.
   *
   * @param {Buffer} buf - The header data to write.
   * @throws {Error} If the header data exceeds the maximum allowed size.
   */
  async writeHeader(buf: Buffer): Promise<void> {
    await Promise.resolve();
    const maxClientHeader = this.blockSize - HEADER_CLIENT_AREA_OFFSET;
    if (buf.length > maxClientHeader) {
      throw new Error(`header too large for block 0; max ${maxClientHeader} bytes`);
    }
    this.cachedHeaderBuf = Buffer.from(buf);
    this.stageHeaderBlock();
  }

  private stageHeaderBlock(): void {
    const b = Buffer.alloc(this.blockSize, 0);
    b.writeUInt32LE(this.cachedFreeListHead >>> 0, FREE_LIST_HEAD_OFFSET);
    b.writeUInt32LE(this.cachedHeaderBuf.length >>> 0, HEADER_LENGTH_OFFSET);
    if (this.cachedHeaderBuf.length > 0) {
      this.cachedHeaderBuf.copy(b, HEADER_CLIENT_AREA_OFFSET, 0, this.cachedHeaderBuf.length);
    }
    this.stagedWrites.set(0, b);
  }

  /**
   * Allocate a number of blocks, reusing free blocks if available.
   *
   * @param {number} count - The number of blocks to allocate.
   * @returns {Promise<number | number[]>} The block IDs of the allocated blocks.
   * @throws {Error} If the count is not positive.
   */
  async allocateBlocks(count: number): Promise<number | number[]> {
    this.ensureOpened();
    if (count <= 0) throw new Error('count must be positive');

    const allocated: number[] = [];

    while (allocated.length < count && this.cachedFreeListHead !== NO_BLOCK) {
      const head = this.cachedFreeListHead;
      const headBuf = await this.readRawBlock(head);
      const next = headBuf.readUInt32LE(FREE_LIST_HEAD_OFFSET);
      this.cachedFreeListHead = next;
      allocated.push(head);
    }

    if (allocated.length < count) {
      const st = await this.file.stat();
      const currentBlocks = Math.floor(st.size / this.blockSize);
      const need = count - allocated.length;

      const maxStaged = this.getMaxReservedBlockId();

      const base = Math.max(currentBlocks, maxStaged + 1);

      for (let i = 0; i < need; i++) {
        const newId = base + i;
        const newBlock = Buffer.alloc(this.blockSize, 0);
        newBlock.writeUInt32LE(NO_BLOCK >>> 0, FREE_LIST_HEAD_OFFSET);
        this.stagedWrites.set(newId, newBlock);
        allocated.push(newId);
      }
    }

    this.stageHeaderBlock();

    if (count === 1) {
      return allocated[0];
    }

    return allocated;
  }

  /**
   * Allocate blocks and write the given data as a blob.
   *
   * @param {Buffer} data - The data to write.
   * @returns {Promise<number>} The block ID of the first block of the allocated blob.
   */
  async allocateAndWrite(data: Buffer): Promise<number> {
    //[DEBUG]
    debug_incrementWriteCounts('allocateAndWrite()');
    //

    this.ensureOpened();
    const payload = this.encodePayload(data);
    const lengthPrefix = Buffer.alloc(LENGTH_PREFIX_SIZE);
    lengthPrefix.writeBigUInt64LE(BigInt(payload.length), 0);
    const full = Buffer.concat([lengthPrefix, payload]);
    const needed = Math.ceil(full.length / this.payloadSize) || 1;

    const blocksOrNumber = await this.allocateBlocks(needed);
    const blocks = Array.isArray(blocksOrNumber) ? blocksOrNumber : [blocksOrNumber];
    const firstBlock = blocks[0];

    for (let i = 0; i < blocks.length; i++) {
      const blockId = blocks[i];
      const next = i + 1 < blocks.length ? blocks[i + 1] : NO_BLOCK;
      const out = Buffer.alloc(this.blockSize, 0);
      out.writeUInt32LE(next >>> 0, FREE_LIST_HEAD_OFFSET);
      const start = i * this.payloadSize;
      const end = Math.min(start + this.payloadSize, full.length);
      full.copy(out, NEXT_POINTER_SIZE, start, end);
      this.stagedWrites.set(blockId, out);
    }

    return firstBlock;
  }

  /**
   * Allocate blocks and write the given data array as multiple blobs in one batch
   * @param {Buffer[]} data The data to write.
   * @returns {Promise<number[]>} The block IDs of the first block of each allocated blob.
   */
  async allocateAndWriteMany(data: Buffer[]): Promise<number[]> {
    //[DEBUG]
    debug_incrementWriteCounts('allocateAndWriteMany()');
    //

    this.ensureOpened();
    if (data.length === 0) {
      return [];
    }

    const fullBuffers: Buffer[] = [];
    const neededPerBlob: number[] = [];

    for (const d of data) {
      if (!Buffer.isBuffer(d)) {
        throw new Error('data array must contain Buffer instances');
      }

      const payload = this.encodePayload(d);
      const lengthPrefix = Buffer.alloc(LENGTH_PREFIX_SIZE);
      lengthPrefix.writeBigUInt64LE(BigInt(payload.length), 0);
      const full = Buffer.concat([lengthPrefix, payload]);
      fullBuffers.push(full);
      neededPerBlob.push(Math.ceil(full.length / this.payloadSize) || 1);
    }

    const totalNeeded = neededPerBlob.reduce((sum, needed) => sum + needed, 0);

    const st = await this.file.stat();
    const currentBlocks = Math.floor(st.size / this.blockSize);
    const maxReserved = this.getMaxReservedBlockId();
    const base = Math.max(currentBlocks, maxReserved + 1);

    const allBlocks = new Array<number>(totalNeeded);
    for (let i = 0; i < totalNeeded; i++) {
      allBlocks[i] = base + i;
    }

    const firstBlocks: number[] = [];
    let cursor = 0;

    const extentBuffer = Buffer.alloc(totalNeeded * this.blockSize, 0);
    let absoluteBlockOffset = 0;

    for (let blobIndex = 0; blobIndex < fullBuffers.length; blobIndex++) {
      const full = fullBuffers[blobIndex];
      const needed = neededPerBlob[blobIndex];
      const blobBlocks = allBlocks.slice(cursor, cursor + needed);
      firstBlocks.push(blobBlocks[0]);

      for (let i = 0; i < blobBlocks.length; i++) {
        const next = i + 1 < blobBlocks.length ? blobBlocks[i + 1] : NO_BLOCK;
        const outOffset = absoluteBlockOffset * this.blockSize;
        extentBuffer.writeUInt32LE(next >>> 0, outOffset + FREE_LIST_HEAD_OFFSET);

        const start = i * this.payloadSize;
        const end = Math.min(start + this.payloadSize, full.length);
        full.copy(extentBuffer, outOffset + NEXT_POINTER_SIZE, start, end);
        absoluteBlockOffset++;
      }

      cursor += needed;
    }

    this.stagedBatchWrites.push({
      startBlockId: base,
      blockCount: totalNeeded,
      buffer: extentBuffer,
    });

    return firstBlocks;
  }

  /**
   * Overwrite an existing blob starting at the given block ID.
   * Reuses the existing block chain if possible, allocating or freeing blocks as needed.
   *
   * @param {number} startBlockId - The block ID of the first block to overwrite.
   * @param {Buffer} data - The data to write.
   * @returns {Promise<void>} A promise that resolves when the overwrite is complete.
   */
  async overwriteBlock(startBlockId: number, data: Buffer): Promise<void> {
    //[DEBUG]
    debug_incrementWriteCounts('overwriteBlock()');
    //

    this.ensureOpened();
    if (startBlockId === NO_BLOCK) {
      throw new Error('Cannot overwrite NO_BLOCK');
    }

    const payload = this.encodePayload(data);
    const lengthPrefix = Buffer.alloc(LENGTH_PREFIX_SIZE);
    lengthPrefix.writeBigUInt64LE(BigInt(payload.length), 0);
    const full = Buffer.concat([lengthPrefix, payload]);
    const needed = Math.ceil(full.length / this.payloadSize) || 1;

    // Collect existing blocks in the chain
    let current = startBlockId;
    const existingBlocks: number[] = [];
    while (current !== NO_BLOCK && existingBlocks.length < needed) {
      existingBlocks.push(current);
      const blockBuf = await this.readRawBlock(current);
      current = blockBuf.readUInt32LE(FREE_LIST_HEAD_OFFSET);
    }

    // If we have extra blocks in the old chain, free them
    if (current !== NO_BLOCK) {
      await this.freeBlob(current);
    }

    // If we need more blocks, allocate them
    if (existingBlocks.length < needed) {
      const additionalNeeded = needed - existingBlocks.length;
      const newBlocksOrNumber = await this.allocateBlocks(additionalNeeded);
      const newBlocks = Array.isArray(newBlocksOrNumber) ? newBlocksOrNumber : [newBlocksOrNumber];
      existingBlocks.push(...newBlocks);
    }

    // Write data to the blocks
    for (let i = 0; i < existingBlocks.length; i++) {
      const blockId = existingBlocks[i];
      const next = i + 1 < existingBlocks.length ? existingBlocks[i + 1] : NO_BLOCK;
      const out = Buffer.alloc(this.blockSize, 0);
      out.writeUInt32LE(next >>> 0, FREE_LIST_HEAD_OFFSET);
      const start = i * this.payloadSize;
      const end = Math.min(start + this.payloadSize, full.length);
      full.copy(out, NEXT_POINTER_SIZE, start, end);
      this.stagedWrites.set(blockId, out);
    }
  }

  /**
   * Free a blob starting from the given block ID.
   *
   * @param {number} startBlockId - The block ID of the first block of the blob to free.
   */
  async freeBlob(startBlockId: number): Promise<void> {
    await Promise.resolve();
    this.ensureOpened();
    if (startBlockId === NO_BLOCK) return;

    this.pendingFrees.push(startBlockId);
  }

  /**
   * Read a blob starting from the given block ID.
   *
   * @param {number} startBlockId - The block ID of the first block of the blob to read.
   * @returns {Promise<Buffer>} The data read from the blob.
   */
  async readBlob(startBlockId: number): Promise<Buffer> {
    // [DEBUG]
    debug_incrementDiskReadCount();
    //

    this.ensureOpened();
    if (startBlockId === NO_BLOCK) return Buffer.alloc(0);

    const parts: Buffer[] = [];
    let current = startBlockId;
    while (current !== NO_BLOCK) {
      const blockBuf = await this.readRawBlock(current);
      const next = blockBuf.readUInt32LE(FREE_LIST_HEAD_OFFSET);
      const payload = blockBuf.slice(NEXT_POINTER_SIZE);
      parts.push(Buffer.from(payload));
      current = next;
    }
    const full = Buffer.concat(parts);
    if (full.length < LENGTH_PREFIX_SIZE) return Buffer.alloc(0);
    const len = Number(full.readBigUInt64LE(0));
    const payload = full.slice(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + len);
    return this.decodePayload(payload);
  }

  encodePayload(data: Buffer): Buffer {
    if (data.length < FreeBlockFile.NODE_MIN_SAVED_BYTES) {
      return Buffer.from(data);
    }

    const compressed = this.compressionService.compress(data);
    const envelopeBytes = COMPRESSION_ENVELOPE_HEADER_SIZE;
    const compressedTotal = compressed.payload.length + envelopeBytes;

    if (compressedTotal >= data.length - FreeBlockFile.NODE_MIN_SAVED_BYTES) {
      return Buffer.from(data);
    }

    return serializeCompressionEnvelope(FREEBLOCK_COMPRESSED_PAYLOAD_MAGIC, compressed);
  }

  decodePayload(payload: Buffer): Buffer {
    const decoded = deserializeCompressionEnvelope(payload, FREEBLOCK_COMPRESSED_PAYLOAD_MAGIC);
    if (decoded === null) {
      return Buffer.from(payload);
    }

    try {
      return this.compressionService.decompress(decoded);
    } catch {
      return Buffer.from(payload);
    }
  }

  async readRawBlock(blockId: number): Promise<Buffer> {
    if (this.stagedWrites.has(blockId)) {
      return Buffer.from(this.stagedWrites.get(blockId)!);
    }

    for (const extent of this.stagedBatchWrites) {
      if (blockId >= extent.startBlockId && blockId < extent.startBlockId + extent.blockCount) {
        const relativeIndex = blockId - extent.startBlockId;
        const offset = relativeIndex * this.blockSize;
        return Buffer.from(extent.buffer.slice(offset, offset + this.blockSize));
      }
    }

    const pos = blockId * this.blockSize;
    const st = await this.file.stat();
    if (pos >= st.size) {
      const z = Buffer.alloc(this.blockSize, 0);
      z.writeUInt32LE(NO_BLOCK >>> 0, FREE_LIST_HEAD_OFFSET);
      return z;
    }
    const buf = Buffer.alloc(this.blockSize);
    await this.file.read(buf, { position: pos });
    return buf;
  }

  /**
   * CURRENTLY UNUSED METHOD:
   * Collect a chain of allocated blocks starting from the given block ID.
   *
  private async collectAllocatedChain(firstBlock: number, count: number): Promise<number[]> {
    const ids: number[] = [firstBlock];

    let optimistic = true;
    for (let i = 1; i < count; i++) {
      const candidate = firstBlock + i;
      if (!this.stagedWrites.has(candidate)) {
        optimistic = false;
        break;
      }
    }
    if (optimistic) {
      for (let i = 1; i < count; i++) ids.push(firstBlock + i);
      return ids;
    }

    while (ids.length < count) {
      const prev = ids[ids.length - 1];
      const prevBuf = await this.readRawBlock(prev);
      const next = prevBuf.readUInt32LE(FREE_LIST_HEAD_OFFSET);
      if (next === NO_BLOCK) {
        throw new Error('unexpected end of block chain while collecting allocated blocks');
      }
      ids.push(next);
    }
    return ids;
  }
  **/

  /**
   * Commit all staged writes plus any queued frees to the underlying file, expanding the file if necessary
   * and refreshing the cached header state.
   */
  async commit(): Promise<void> {
    // [DEBUG]
    debug_incrementWriteCounts('commit()');
    //

    this.ensureOpened();

    if (this.stagedWrites.size === 0 && this.pendingFrees.length === 0 && this.stagedBatchWrites.length === 0) return;

    if (this.pendingFrees.length > 0) {
      for (const chainStart of this.pendingFrees) {
        let current = chainStart;
        while (current !== NO_BLOCK) {
          const raw = await this.readRawBlock(current);
          const nextInChain = raw.readUInt32LE(FREE_LIST_HEAD_OFFSET);

          const freeBuf = Buffer.alloc(this.blockSize, 0);
          freeBuf.writeUInt32LE(this.cachedFreeListHead >>> 0, FREE_LIST_HEAD_OFFSET);

          this.stagedWrites.set(current, freeBuf);

          this.cachedFreeListHead = current;

          current = nextInChain;
        }
      }

      this.stageHeaderBlock();
    }

    if (!this.stagedWrites.has(0)) this.stageHeaderBlock();

    const writes: { position: number; buffer: Buffer }[] = [];
    let maxBlockId = 0;
    for (const [blockId, buf] of this.stagedWrites) {
      writes.push({ position: blockId * this.blockSize, buffer: Buffer.from(buf) });
      if (blockId > maxBlockId) maxBlockId = blockId;
    }

    for (const extent of this.stagedBatchWrites) {
      writes.push({ position: extent.startBlockId * this.blockSize, buffer: Buffer.from(extent.buffer) });
      const endBlockId = extent.startBlockId + extent.blockCount - 1;
      if (endBlockId > maxBlockId) maxBlockId = endBlockId;
    }

    const desiredSize = (maxBlockId + 1) * this.blockSize;
    const st = await this.file.stat();
    if (st.size < desiredSize) {
      await this.file.truncate(desiredSize);
    }

    if (this.atomicFile.begin && this.atomicFile.journalWrite && this.atomicFile.commitDataToWal) {
      this.atomicFile.getOpenAndInTransaction();
      if (!this.atomicFile.getOpenAndInTransaction()) {
        await this.atomicFile.begin();
      }

      for (const write of writes) {
        await this.atomicFile.journalWrite(write.position, write.buffer);
      }
      await this.atomicFile.commitDataToWal();
      await this.atomicFile.checkpoint();
    } else {
      throw new Error('Underlying atomicFile does not support required operations for commit');
    }

    const headerBlock = this.stagedWrites.get(0);
    if (headerBlock) {
      this.cachedFreeListHead = headerBlock.readUInt32LE(FREE_LIST_HEAD_OFFSET);
      const headerLen = headerBlock.readUInt32LE(HEADER_LENGTH_OFFSET);
      this.cachedHeaderBuf =
        headerLen > 0
          ? Buffer.from(headerBlock.slice(HEADER_CLIENT_AREA_OFFSET, HEADER_CLIENT_AREA_OFFSET + headerLen))
          : Buffer.alloc(0);
    }

    this.stagedWrites.clear();
    this.stagedBatchWrites = [];
    this.pendingFrees = [];
  }

  /**
   * Checkpoint all committed data to the database.
   */
  async checkpoint() {
    await this.atomicFile.checkpoint();
  }

  /**
   * Stage a raw block for writing.
   *
   * @param {number} blockId - The block ID to stage.
   * @param {Buffer} buf - The block data to write.
   * @throws {Error} If the block data does not match the block size.
   */
  async stageRawBlock(blockId: number, buf: Buffer): Promise<void> {
    this.ensureOpened();
    await Promise.resolve();
    if (buf.length !== this.blockSize) throw new Error('raw block must have blockSize length');
    this.stagedWrites.set(blockId, Buffer.from(buf));
    if (blockId === 0) {
      this.cachedFreeListHead = buf.readUInt32LE(FREE_LIST_HEAD_OFFSET);
      const headerLen = buf.readUInt32LE(HEADER_LENGTH_OFFSET);
      this.cachedHeaderBuf =
        headerLen > 0
          ? Buffer.from(buf.slice(HEADER_CLIENT_AREA_OFFSET, HEADER_CLIENT_AREA_OFFSET + headerLen))
          : Buffer.alloc(0);
      this.stageHeaderBlock();
    }
  }

  /**
   * @returns {Promise<number>} The current head of the free list.
   */
  async debug_getFreeListHead(): Promise<number> {
    return Promise.resolve(this.cachedFreeListHead);
  }

  private getMaxReservedBlockId(): number {
    let maxReserved = 0;

    for (const id of this.stagedWrites.keys()) {
      if (id > maxReserved) maxReserved = id;
    }

    for (const extent of this.stagedBatchWrites) {
      const endBlockId = extent.startBlockId + extent.blockCount - 1;
      if (endBlockId > maxReserved) maxReserved = endBlockId;
    }

    return maxReserved;
  }

  /**
   * Returns the total number of blocks in the file (including block 0).
   */
  async getTotalBlockCount(): Promise<number> {
    const st = await this.file.stat();
    return Math.floor(st.size / this.blockSize);
  }

  /**
   * Returns the underlying file handle.
   */
  getFile(): File {
    return this.file;
  }
}
