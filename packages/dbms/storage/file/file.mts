// @author Tijn Gommers
// @date 2025-11-18

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Abstraction for a file, supporting atomic sector writes and basic file operations.
 * Implementations may be real files or in-memory/mocked files.
 */
export interface File {
  /**
   * The maximum N such that writes of size N at offsets that are multiples of N are atomic.
   */
  readonly sectorSize: number;

  /**
   * Creates a new file or overwrites an existing file.
   * @returns {Promise<void>} Resolves when the file is created.
   */
  create(): Promise<void>;

  /**
   * Opens an existing file for reading and writing.
   * @returns {Promise<void>} Resolves when the file is open.
   */
  open(): Promise<void>;

  /**
   * Closes the file.
   * @returns {Promise<void>} Resolves when the file is closed.
   * @throws {Error} If the file is not currently open.
   */
  close(): Promise<void>;

  /**
   * Ensures that all buffered writes are flushed to disk.
   * @returns {Promise<void>} Resolves when sync is complete.
   * @throws {Error} If the file is not currently open.
   */
  sync(): Promise<void>;

  /**
   * Writes multiple buffers to the file at the specified position.
   * @param {Buffer[]} buffers - Array of buffers to write.
   * @param {number} position - Offset in the file to start writing.
   * @returns {Promise<void>} Resolves when the write completes.
   * @throws {Error} If the file is not currently open.
   */
  writev(buffers: Buffer[], position: number): Promise<void>;

  /**
   * Reads data from the file into a buffer at the specified position.
   * @param {Buffer} buffer - The buffer to fill with read data.
   * @param {{position: number, offset?: number}} options - Object containing the read position and optional buffer offset.
   * @returns {Promise<void>} Resolves when the read completes.
   * @throws {Error} If the file is not currently open.
   */
  read(buffer: Buffer, options: { position: number; offset?: number }): Promise<void>;

  /**
   * Truncates the file to the specified length.
   * @param {number} length - New length of the file in bytes.
   * @returns {Promise<void>} Resolves when truncation completes.
   * @throws {Error} If the file is not currently open.
   */
  truncate(length: number): Promise<void>;

  /**
   * Returns file statistics.
   * @returns {Promise<{size: number}>} Resolves with an object containing the file size in bytes.
   * @throws {Error} If the file is not currently open.
   */
  stat(): Promise<{ size: number }>;
}

/**
 * Real file implementation using Node.js fs/promises.
 * Supports all File interface operations with real disk I/O.
 */
export class RealFile implements File {
  /** Sector size for atomic writes. */
  public readonly sectorSize: number;

  /** Absolute path to the file on disk. */
  public readonly filePath: string;

  /** Internal file handle for fs operations; null if closed. */
  private fileHandle: fsPromises.FileHandle | null;

  /**
   * Constructs a RealFile for a given path.
   * @param {string} filePath - Absolute or relative path to the file.
   * @param {number} sectorSize - Sector size for atomic writes. Defaults to 4096 bytes.
   */
  public constructor(filePath: string, sectorSize: number = 4096) {
    this.filePath = filePath;
    this.sectorSize = sectorSize;
    this.fileHandle = null;
  }

  /**
   * Checks if the file is currently open.
   * @returns {boolean} True if open, false otherwise.
   */
  public isOpen(): boolean {
    return this.fileHandle !== null;
  }

  /**
   * Checks if the file exists on disk.
   * @returns {Promise<boolean>} True if the file exists, false otherwise.
   */
  public async exists(): Promise<boolean> {
    try {
      await fsPromises.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deletes the file from disk.
   * @returns {Promise<void>} Resolves when deletion completes.
   * @throws {Error} If the file is currently open.
   */
  public async delete(): Promise<void> {
    if (this.isOpen()) {
      throw new Error('Cannot delete an open file.');
    }
    await fsPromises.rm(this.filePath, { force: true });
  }

  /**
   * Creates or overwrites the file.
   * @returns {Promise<void>} Resolves when creation is complete.
   * @throws {Error} If the file is already open.
   */
  public async create(): Promise<void> {
    if (this.isOpen()) throw new Error('File is already open.');
    await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
    this.fileHandle = await fsPromises.open(this.filePath, 'w+');
  }

  /**
   * Opens the file for reading and writing.
   * @returns {Promise<void>} Resolves when the file is open.
   * @throws {Error} If the file is already open.
   */
  public async open(): Promise<void> {
    if (this.isOpen()) throw new Error('File is already open.');
    this.fileHandle = await fsPromises.open(this.filePath, 'r+');
  }

  /**
   * Closes the file handle.
   * @returns {Promise<void>} Resolves when closed.
   * @throws {Error} If the file is not currently open.
   */
  public async close(): Promise<void> {
    if (!this.isOpen()) throw new Error('File is not open.');
    await this.fileHandle!.close();
    this.fileHandle = null;
  }

  /**
   * Flushes all buffered writes to disk.
   * @returns {Promise<void>} Resolves when sync is complete.
   * @throws {Error} If the file is not currently open.
   */
  public async sync(): Promise<void> {
    if (!this.isOpen()) throw new Error('File is not open.');
    await this.fileHandle!.sync();
  }

  /**
   * Writes multiple buffers at a given file offset.
   * @param {Buffer[]} buffers - Buffers to write.
   * @param {number} position - Offset in the file to start writing.
   * @returns {Promise<void>} Resolves when writing is complete.
   * @throws {Error} If the file is not currently open.
   */
  public async writev(buffers: Buffer[], position: number): Promise<void> {
    if (!this.isOpen()) throw new Error('File is not open.');
    await this.fileHandle!.writev(buffers, position);
  }

  /**
   * Reads from the file into a buffer.
   * @param {Buffer} buffer - Buffer to fill with data.
   * @param {{position: number, offset?: number}} options - Position to start reading and optional buffer offset.
   * @returns {Promise<void>} Resolves when reading is complete.
   * @throws {Error} If the file is not currently open.
   */
  public async read(buffer: Buffer, options: { position: number; offset?: number }): Promise<void> {
    if (!this.isOpen()) throw new Error('File is not open.');
    const bufferOffset = options.offset ?? 0;
    await this.fileHandle!.read(buffer, bufferOffset, buffer.length - bufferOffset, options.position);
  }

  /**
   * Truncates the file to the given length.
   * @param {number} length - New file size in bytes.
   * @returns {Promise<void>} Resolves when truncation is complete.
   * @throws {Error} If the file is not currently open.
   */
  public async truncate(length: number): Promise<void> {
    if (length < 0) throw new Error('File is not open.');
    if (!this.isOpen()) throw new Error('File is not open.');
    await this.fileHandle!.truncate(length);
  }

  /**
   * Returns file statistics, including size.
   * @returns {Promise<{size: number}>} Object containing the file size.
   * @throws {Error} If the file is not currently open.
   */
  public async stat(): Promise<{ size: number }> {
    if (!this.isOpen()) throw new Error('File is not open.');
    const stats = await this.fileHandle!.stat();
    return { size: stats.size };
  }
}
