// @author Frederick Hillen, Arwin Gorissen
// @date 2025-03-16

import type { File } from '../../storage/file/file.mjs';
import { RealFile } from '../../storage/file/file.mjs';

// Shared magic number that appears at the start of every WAL record.
const WAL_MAGIC = 0x574c4152;

const RECORD_TYPE_WRITE = 1;
const RECORD_TYPE_COMMIT = 2;

// WRITE record layout (24-byte header + payload):
//   [magic(4)][type(4)][offset(8)][payloadLength(4)][payloadChecksum(4)][payload...]
const WRITE_HEADER_SIZE = 24;

// COMMIT record layout (8 bytes, no payload):
//   [magic(4)][type(4)]
const COMMIT_RECORD_SIZE = 8;

const WAL_SIZE_LIMIT = 100 * 1024 * 1024; // 100 MB

const NIL_UUID: string = '00000000-0000-0000-0000-000000000000';

/**
 * Interface to manage the write-ahead log.
 */
export interface WALManager {
  openWAL(): Promise<void>;
  closeWAL(): Promise<void>;
  logWrite(offset: number, data: Uint8Array): Promise<void>;
  addCommitMarker(): Promise<void>;
  sync(): Promise<void>;
  checkpoint(): Promise<void>;
  recover(): Promise<void>;
  clearLog(): Promise<void>;
}

/**
 *  Small async mutex used to serialize WAL file operations
 *  to avoid races (used in every function of wal-manager).
 */
export class Mutex {
  private locked = false;
  private waiters: (() => void)[] = [];

  /**
   * Acquires the mutex lock.
   *
   * If the mutex is free, this call resolves immediately and returns an
   * `unlock` function.
   * If the mutex is already locked, the caller is queued and the Promise
   * resolves only when the mutex becomes available.
   *
   * @returns A function that releases the lock.
   */
  async lock(): Promise<() => void> {
    return new Promise((resolve) => {
      const take = () => {
        this.locked = true;
        resolve(() => {
          this.locked = false;
          const next = this.waiters.shift();
          if (next) next();
        });
      };
      if (!this.locked) take();
      else this.waiters.push(take);
    });
  }
  /**
   * Runs the given asynchronous function with exclusive access to the mutex.
   *
   * This helper acquires the lock, executes the provided function fn,
   * and guarantees that the lock is released afterwards.
   *
   * @param {() => Promise<T>} fn A function representing the critical section.
   * @returns {T} The return value of fn.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const unlock = await this.lock();
    try {
      return await fn();
    } finally {
      unlock();
    }
  }
}

/**
 * Implementation of the write-ahead log manager,
 * that executes operations on the wal.
 */
export class WALManagerImpl implements WALManager {
  private walFile: File;
  private dbFile: File;
  private mutex: Mutex = new Mutex();
  private opened: boolean = false;
  private diskStorageWalFile?: File;

  /**
   * Constructor
   * @param {File} walFile the write-ahead log file
   * @param {File} dbFile the database file
   */
  public constructor(walFile: File, dbFile: File, diskStorageWalFile?: File) {
    this.walFile = walFile;
    this.dbFile = dbFile;
    this.diskStorageWalFile = diskStorageWalFile;
  }

  /**
   * Opens the WAL and database files.
   */
  public async openWAL(): Promise<void> {
    return this.mutex.runExclusive(async () => {
      if (this.opened) return;
      try {
        if (this.walFile instanceof RealFile) {
          const walIsOpen = this.walFile.isOpen();
          if (!walIsOpen) await this.walFile.open();
        }
      } catch (err) {
        if (!(err instanceof Error && err.message === 'File is already open.')) throw err;
      }

      try {
        if (this.dbFile instanceof RealFile) {
          const dbIsOpen = this.dbFile.isOpen();
          if (!dbIsOpen) await this.dbFile.open();
        } else {
          // Unknown File implementation: attempt to open and tolerate
          // the "File is already open." error message if thrown.
          try {
            await this.dbFile.open();
          } catch (err) {
            if (!(err instanceof Error && err.message === 'File is already open.')) throw err;
          }
        }
      } catch (err) {
        if (!(err instanceof Error && err.message === 'File is already open.')) throw err;
      }
      this.opened = true;
    });
  }

  /**
   * Closes the WAL and database files.
   */
  public async closeWAL(): Promise<void> {
    return this.mutex.runExclusive(async () => {
      if (!this.opened) return;
      // Closing should be tolerant if underlying File was closed elsewhere.
      try {
        if (this.walFile instanceof RealFile) {
          const walIsOpen = this.walFile.isOpen();
          if (walIsOpen) await this.walFile.close();
        } else {
          try {
            await this.walFile.close();
          } catch (err) {
            if (!(err instanceof Error && err.message === 'File is not open.')) throw err;
          }
        }
      } catch (err) {
        if (!(err instanceof Error && err.message === 'File is not open.')) throw err;
      }

      try {
        if (this.dbFile instanceof RealFile) {
          const dbIsOpen = this.dbFile.isOpen();
          if (dbIsOpen) await this.dbFile.close();
        } else {
          try {
            await this.dbFile.close();
          } catch (err) {
            if (!(err instanceof Error && err.message === 'File is not open.')) throw err;
          }
        }
      } catch (err) {
        if (!(err instanceof Error && err.message === 'File is not open.')) throw err;
      }
      this.opened = false;
    });
  }

  /**
   * Writes data to the WAL.
   * @param {number} offset a number >= 0 at which the data needs to be written in the database
   * @param {Uint8Array} data a Uint8Array at which the data to be written to the database
   */
  public async logWrite(offset: number, data: Uint8Array): Promise<void> {
    return this.mutex.runExclusive(async () => {
      const walSize: number = await this.walFile.stat().then((stat) => stat.size);
      const recordSize = WRITE_HEADER_SIZE + data.length;
      if (walSize + recordSize > WAL_SIZE_LIMIT) {
        console.log('WAL size limit reached. Triggering automatic checkpoint.');
        await this.checkpointInternalWithoutMutex();
      }

      const checksum: number = this.checksumCalculator(data);
      const header = Buffer.alloc(WRITE_HEADER_SIZE);
      header.writeUInt32LE(WAL_MAGIC, 0);
      header.writeUInt32LE(RECORD_TYPE_WRITE, 4);
      header.writeBigUInt64LE(BigInt(offset), 8);
      header.writeUInt32LE(data.length, 16);
      header.writeUInt32LE(checksum, 20);
      const pos: number = await this.walFile.stat().then((stat) => stat.size);
      await this.walFile.writev([header, Buffer.from(data)], pos);
    });
  }

  /**
   * Commits the data to the WAL to ensure it is complete
   * before writing to database.
   */
  public async addCommitMarker(): Promise<void> {
    return this.mutex.runExclusive(async () => {
      const walSize: number = await this.walFile.stat().then((stat) => stat.size);
      if (walSize + COMMIT_RECORD_SIZE > WAL_SIZE_LIMIT) {
        console.log('WAL size limit reached. Triggering automatic checkpoint.');
        await this.checkpointInternalWithoutMutex();
      }

      const record = Buffer.alloc(COMMIT_RECORD_SIZE);
      record.writeUInt32LE(WAL_MAGIC, 0);
      record.writeUInt32LE(RECORD_TYPE_COMMIT, 4);
      const pos: number = await this.walFile.stat().then((stat) => stat.size);
      await this.walFile.writev([record], pos);
    });
  }

  /**
   * Syncs the WAL-file
   */
  public async sync(): Promise<void> {
    return this.mutex.runExclusive(async () => {
      await this.walFile.sync();
    });
  }

  /**
   * Writes all committed data in the WAL to the database and clears the WAL.
   */
  public async checkpoint(): Promise<void> {
    return this.mutex.runExclusive(async () => {
      await this.checkpointInternal();
      await this.dbFile.sync();
      await this.walFile.truncate(0);
      await this.walFile.sync();
    });
  }

  /**
   * internal checkpoint implementation that does not acquire the mutex.
   */
  private async checkpointInternal(): Promise<void> {
    const walSize: number = await this.walFile.stat().then((stat) => stat.size);
    if (walSize === 0) return;

    const buffer = Buffer.alloc(walSize);
    await this.walFile.read(buffer, { position: 0 });

    const committedData = this.getCommittedData(walSize, buffer);
    for (const w of committedData.writes) {
      await this.dbFile.writev([Buffer.from(w.data)], w.offset);
    }
  }

  /**
   * Internal checkpoint with full durability cycle without acquiring the mutex.
   * Called when WAL size limit is reached during logWrite or addCommitMarker.
   */
  private async checkpointInternalWithoutMutex(): Promise<void> {
    await this.checkpointInternal();
    await this.dbFile.sync();
    await this.walFile.truncate(0);
    await this.walFile.sync();
  }

  /**
   * Helper function that extracts all committed data from the WAL.
   * @param {number} walSize a number > 0, the size of the WAL
   * @param {Buffer} buffer contents of WAL
   * @returns {{ writes: { offset: number; data: Buffer }[] }} An object containing an array writes, of which each element represents a fully committed write.
   */
  private getCommittedData(walSize: number, buffer: Buffer): { writes: { offset: number; data: Buffer }[] } {
    let pos = 0;
    const writes: { offset: number; data: Buffer }[] = [];
    let tempWrites: { offset: number; data: Buffer }[] = [];

    while (pos + COMMIT_RECORD_SIZE <= walSize) {
      const magic = buffer.readUInt32LE(pos);
      const nlsHex: string = buffer.subarray(walSize - 16, walSize).toString('hex');
      const nlsCommitMarker: string = `${nlsHex.slice(0, 8)}-${nlsHex.slice(8, 12)}-${nlsHex.slice(12, 16)}-${nlsHex.slice(16, 20)}-${nlsHex.slice(20)}`;
      if (this.diskStorageWalFile !== undefined && nlsCommitMarker !== NIL_UUID) break;
      if (magic !== WAL_MAGIC) break;

      const recordType = buffer.readUInt32LE(pos + 4);

      if (recordType === RECORD_TYPE_WRITE) {
        if (pos + WRITE_HEADER_SIZE > walSize) break;
        const offset = Number(buffer.readBigUInt64LE(pos + 8));
        const payloadLength = buffer.readUInt32LE(pos + 16);
        const payloadChecksum = buffer.readUInt32LE(pos + 20);
        if (pos + WRITE_HEADER_SIZE + payloadLength > walSize) break;
        const data = buffer.subarray(pos + WRITE_HEADER_SIZE, pos + WRITE_HEADER_SIZE + payloadLength);
        if (this.checksumCalculator(data) !== payloadChecksum) {
          console.log('Corrupted WAL record detected. Preserving previously committed records and stopping replay.');
          tempWrites = [];
          break;
        }
        tempWrites.push({ offset, data });
        pos += WRITE_HEADER_SIZE + payloadLength;
      } else if (recordType === RECORD_TYPE_COMMIT) {
        for (const w of tempWrites) {
          writes.push(w);
        }
        tempWrites = [];
        pos += COMMIT_RECORD_SIZE;
      } else {
        break;
      }
    }

    return { writes };
  }

  /**
   * Checks for a crash and reruns checkpoint if the WAL contains
   * any committed data to ensure crash consistency.
   */
  public async recover(): Promise<void> {
    return this.mutex.runExclusive(async () => {
      const journalSize: number = await this.walFile.stat().then((stat) => stat.size);
      if (!(journalSize > 0)) {
        return;
      }

      // Sanity check: WAL file size should not exceed the limit.
      // If it does, the file is likely corrupted. Truncate and return.
      if (journalSize > WAL_SIZE_LIMIT) {
        console.error(
          `WAL file size ${journalSize} exceeds limit ${WAL_SIZE_LIMIT}. Treating as corrupt and truncating.`,
        );
        await this.walFile.truncate(0);
        await this.walFile.sync();
        return;
      }

      console.log('A crash has been detected. Trying to recover WAL...');

      const journalBuffer: Buffer = Buffer.alloc(journalSize);
      await this.walFile.read(journalBuffer, { position: 0 });

      const committedData = this.getCommittedData(journalSize, journalBuffer);
      if (committedData.writes.length === 0) {
        console.log('No committed changes detected. Flushing...');
        await this.walFile.truncate(0);
        await this.walFile.sync();
        return;
      }

      console.log('Recovering committed WAL...');
      await this.checkpointInternal();
      await this.dbFile.sync();
      console.log('Committed changes succesfully recovered.');
      await this.walFile.truncate(0);
      await this.walFile.sync();
    });
  }

  public async clearLog(): Promise<void> {
    return this.mutex.runExclusive(async () => {
      await this.walFile.truncate(0);
    });
  }

  private checksumCalculator(buf: Uint8Array | Buffer): number {
    let hash = 0x811c9dc5 >>> 0;
    for (const b of buf) {
      hash ^= b & 0xff;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
  }

  // Helper functions for testing

  public getOpen(): boolean {
    return this.opened;
  }
}
