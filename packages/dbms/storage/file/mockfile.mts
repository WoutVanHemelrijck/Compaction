// @author Tijn Gommers
// @date 2025-11-18

import assert from 'node:assert/strict';
import random from 'random';
import type { File } from './file.mjs';

/**
 * Mock implementation of the File interface.
 * Stores data in-memory for testing purposes and supports various crash simulations.
 */
export class MockFile implements File {
  /** Sector size for atomic writes. */
  public readonly sectorSize: number;

  /** Current logical file size in bytes. */
  private size: number;

  /** Array of sectors representing stored data. */
  private sectors: Buffer[] = [];

  /**
   * Map of pending writes for each sector.
   * Invariant: each buffer in the value array has length equal to sectorSize.
   */
  private newSectors: Map<number, Buffer[]> = new Map();

  /**
   * Indicates whether the file is currently open.
   */
  private openFlag: boolean = false;

  /**
   * Constructs a new MockFile with a given sector size.
   * @param {number} sectorSize - Size of each sector in bytes.
   */
  public constructor(sectorSize: number) {
    this.sectorSize = sectorSize;
    this.size = 0;
  }

  /**
   * Checks if the file is currently open.
   * @returns {boolean} True if open, false otherwise.
   */
  private ensureOpen(): void {
    if (!this.openFlag) throw new Error('File is not open.');
  }

  /**
   * gets the map of pending writes for testing purposes.
   * @returns {Map<number, Buffer[]>} The map of pending writes.
   */
  public getnewSectors(): Map<number, Buffer[]> {
    return this.newSectors;
  }

  /**
   * Creates a new file.
   * @returns {Promise<void>} Resolves immediately.
   */
  public async create(): Promise<void> {
    this.openFlag = true;
    this.size = 0;
    this.sectors = [];
    this.newSectors.clear();
    return await Promise.resolve();
  }

  /**
   * Opens the file.
   * @returns {Promise<void>} Resolves immediately.
   */
  public async open(): Promise<void> {
    this.openFlag = true;
    this.ensureOpen();
    return await Promise.resolve();
  }

  /**
   * Closes the file. Throws if there are pending writes that have not been synced.
   * @returns {Promise<void>} Resolves when the file is closed.
   * @throws {Error} If there are unsynced writes in newSectors.
   */
  public async close(): Promise<void> {
    // this.ensureOpen();
    if (this.newSectors.size !== 0) throw new Error("Closed the file without sync'ing first.");
    this.openFlag = false;
    return await Promise.resolve();
  }

  /**
   * Synchronizes all pending writes to the main sectors array.
   * @returns {Promise<void>} Resolves when sync is complete.
   */
  public async sync(): Promise<void> {
    // this.ensureOpen();
    for (const [address, writes] of this.newSectors.entries()) {
      this.sectors[address] = writes.at(-1)!;
    }
    this.newSectors.clear();
    return await Promise.resolve();
  }

  /**
   * Reads a sector buffer, returning the latest write if pending.
   * @param {number} sectorOrdinal - Index of the sector to read.
   * @returns {Buffer} The sector buffer.
   * @throws {AssertionError} If sectorOrdinal is out of bounds.
   */
  private read_sector(sectorOrdinal: number): Buffer {
    // this.ensureOpen();
    const i = sectorOrdinal;
    assert(0 <= i && i < this.sectors.length);
    const newSector_i = this.newSectors.get(i);
    return newSector_i ? newSector_i.at(-1)! : this.sectors[i];
  }

  /**
   * Writes a buffer to a specific sector at a given offset.
   * @param {number} offsetInSector - Offset within the sector to start writing.
   * @param {Buffer} buffer - Buffer to write.
   * @param {number} sectorOrdinal - Sector index to write to.
   * @throws {AssertionError} If buffer does not fit in the sector.
   */
  private write_sector(offsetInSector: number, buffer: Buffer, sectorOrdinal: number) {
    // this.ensureOpen();
    assert(buffer.length <= this.sectorSize - offsetInSector);
    // If this write fills an entire sector at offset 0, commit it immediately
    if (offsetInSector === 0 && buffer.length === this.sectorSize) {
      this.sectors[sectorOrdinal] = Buffer.from(buffer);
      // Any pending writes for this sector are now superseded
      this.newSectors.delete(sectorOrdinal);
      return;
    }

    if (buffer.length !== this.sectorSize) {
      const sector = Buffer.from(this.read_sector(sectorOrdinal));
      buffer.copy(sector, offsetInSector);
      buffer = sector;
    } else buffer = Buffer.from(buffer);

    if (!this.newSectors.has(sectorOrdinal)) this.newSectors.set(sectorOrdinal, []);
    this.newSectors.get(sectorOrdinal)!.push(buffer);
  }

  /**
   * Writes multiple buffers to the file at a specified position.
   * @param {Buffer[]} buffers - Buffers to write.
   * @param {number} position - Position in file to start writing.
   * @returns {Promise<void>} Resolves when write is complete.
   */
  public async writev(buffers: Buffer[], position: number): Promise<void> {
    // this.ensureOpen();
    let buffer = Buffer.concat(buffers);
    if (position + buffer.length > this.size) await this.truncate(position + buffer.length);
    let sectorOrdinal = Math.floor(position / this.sectorSize);
    let offsetInSector = position - sectorOrdinal * this.sectorSize;
    while (buffer.length > this.sectorSize - offsetInSector) {
      this.write_sector(offsetInSector, buffer.subarray(0, this.sectorSize - offsetInSector), sectorOrdinal);
      buffer = buffer.subarray(this.sectorSize - offsetInSector);
      sectorOrdinal++;
      offsetInSector = 0;
    }
    if (buffer.length > 0) this.write_sector(offsetInSector, buffer, sectorOrdinal);
    return Promise.resolve();
  }

  /**
   * Reads data from the file into a buffer.
   * @param {Buffer} buffer - Buffer to fill with read data.
   * @param {{position: number}} options - Position to start reading.
   * @returns {Promise<void>} Resolves when read is complete.
   * @throws {AssertionError} If the read exceeds file bounds.
   */
  public async read(buffer: Buffer, options: { position: number }): Promise<void> {
    // this.ensureOpen();
    assert(0 <= options.position);
    assert(options.position + buffer.length <= this.sectors.length * this.sectorSize);
    let sectorOrdinal = Math.floor(options.position / this.sectorSize);
    let offsetInSector = options.position - sectorOrdinal * this.sectorSize;
    while (buffer.length > this.sectorSize - offsetInSector) {
      const sector = this.read_sector(sectorOrdinal);
      sector.copy(buffer, 0, offsetInSector, this.sectorSize);
      buffer = buffer.subarray(this.sectorSize - offsetInSector);
      sectorOrdinal++;
      offsetInSector = 0;
    }
    const sector = this.read_sector(sectorOrdinal);
    sector.copy(buffer, 0, offsetInSector, offsetInSector + buffer.length);
    return Promise.resolve();
  }

  /**
   * Truncates the file to a given length.
   * @param {number} length - New length in bytes.
   * @returns {Promise<void>} Resolves when truncation is complete.
   */
  public async truncate(length: number): Promise<void> {
    // this.ensureOpen();
    const sectorCount = Math.ceil(length / this.sectorSize);
    if (sectorCount < this.sectors.length) {
      this.sectors.length = sectorCount;
      for (const [sectorOrdinal, _writes] of this.newSectors.entries()) {
        if (sectorOrdinal >= sectorCount) this.newSectors.delete(sectorOrdinal);
      }
    } else if (sectorCount > this.sectors.length) {
      for (let sectorOrdinal = this.sectors.length; sectorOrdinal < sectorCount; sectorOrdinal++)
        this.sectors.push(Buffer.alloc(this.sectorSize));
    }
    this.size = length;
    return Promise.resolve();
  }

  /**
   * Returns the file size.
   * @returns {Promise<{size: number}>} Object containing the file size in bytes.
   */
  public async stat(): Promise<{ size: number }> {
    // this.ensureOpen();
    return Promise.resolve({ size: this.size });
  }

  // =====================
  // Crash methods
  // =====================

  /**
   * Simulates a basic crash where a random subset of pending writes are saved.
   * @returns {void}
   */
  public crashBasic(): void {
    for (const [sectorOrdinal, writes] of this.newSectors) {
      const nbWritesToSave = random.uniformInt(0, writes.length)();
      if (nbWritesToSave > 0) this.sectors[sectorOrdinal] = writes[nbWritesToSave - 1];
    }
    this.newSectors.clear();
  }

  /**
   * Simulates a crash where all pending writes are lost.
   * @returns {void}
   */
  public crashFullLoss(): void {
    // Simulate losing everything: both pending writes and committed sectors
    this.newSectors.clear();
    this.sectors = [];
    this.size = 0;
  }

  /**
   * Simulates a crash that partially corrupts the last pending write in each sector.
   * @returns {void}
   */
  public crashPartialCorruption(): void {
    if (this.newSectors.size > 0) {
      for (const [sectorOrdinal, writes] of this.newSectors) {
        const lastWrite = writes.at(-1);
        if (!lastWrite) continue;

        const corrupted = Buffer.from(lastWrite);
        const byteToCorrupt = random.uniformInt(0, corrupted.length - 1)();
        corrupted[byteToCorrupt] ^= 0xff;

        this.sectors[sectorOrdinal] = corrupted;
      }
    } else {
      // If there are no pending writes, corrupt committed sectors instead
      for (let sectorOrdinal = 0; sectorOrdinal < this.sectors.length; sectorOrdinal++) {
        const current = this.sectors[sectorOrdinal];
        if (!current) continue;
        const corrupted = Buffer.from(current);
        const byteToCorrupt = random.uniformInt(0, corrupted.length - 1)();
        corrupted[byteToCorrupt] ^= 0xff;
        this.sectors[sectorOrdinal] = corrupted;
      }
    }
    this.newSectors.clear();
  }

  /**
   * Simulates a mixed crash where some sectors lose all writes and others have corrupted data.
   * @returns {void}
   */
  public crashMixed(): void {
    for (const [sectorOrdinal, writes] of this.newSectors) {
      if (random.bool()) continue; // 50% chance fully  lost

      const nbWritesToSave = random.uniformInt(0, writes.length)();
      if (nbWritesToSave > 0) {
        const saved = Buffer.from(writes[nbWritesToSave - 1]);
        if (random.bool()) {
          const byteToCorrupt = random.uniformInt(0, saved.length - 1)();
          saved[byteToCorrupt] ^= 0xff;
        }
        this.sectors[sectorOrdinal] = saved;
      }
    }
    this.newSectors.clear();
  }
}
