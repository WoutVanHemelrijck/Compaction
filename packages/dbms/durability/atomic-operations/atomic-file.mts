// @author Frederick Hillen, Arwin Gorissen
// @date 2025-03-16

/**
 * INSTRUCTIONS TO USE ATOMIC-FILE:
 * On startup, run:
    await atomic-file.recover();
 * To commit data to the database:
    await atomic-file.begin();              //Start transaction
    await atomic-file.journalWrite(offset: number, data: Uint8Array);  //Do any
    .                                                                    number of
    .                                                                    writes
    .                                                                    to WAL
    await atomic-file.commitDataToWal();   //Definitive commit to WAL
    .                                      //More journalWrites followed by
    .                                        by a commitDataToWAl() can be done
    await atomic-file.checkpoint();        //Write committed data to database
    await atomic-file.safeShutdown();      //Safe shutdown of atomic-file module

  * Example:
    await atomic-file.begin();

    await atomic-file.journalWrite(offset1, data1);
    await atomic-file.journalWrite(offset2, data2);
    await atomic-file.journalWrite(offset3, data3);
    await atomic-file.commitDataToWal();

    await atomic-file.journalWrite(offset4, data4);
    await atomic-file.commitDataToWal();

    await atomic-file.checkpoint();
    await atomic-file.safeShutdown(); 
 */

import type { File } from '../../storage/file/file.mjs';
import { Mutex, type WALManager } from './wal-manager.mjs';

/**
 * Interface to interact with atomic-file.
 */
export interface AtomicFile {
  open(): Promise<void>;
  close(): Promise<void>;
  begin(): Promise<void>;
  journalWrite(offset: number, data: Uint8Array): Promise<void>;
  commitDataToWal(): Promise<void>;
  checkpoint(): Promise<void>;
  getOpenAndInTransaction(): boolean;
  getDBFile?(): File;
  recover?(): Promise<void>;
  abort?(): Promise<void>;
  safeShutdown?(): Promise<void>;
}

/**
 * Implementation of atomicfile to ensure crash consistency.
 */
export class AtomicFileImpl implements AtomicFile {
  private dbFile: File;
  private wal: WALManager;
  private inTransaction: boolean = false;
  private opened: boolean = false;
  private mutex: Mutex = new Mutex();

  public constructor(dbFile: File, walManager: WALManager) {
    this.dbFile = dbFile;
    this.wal = walManager;
  }

  /**
   * Open the WAL and database files.
   */
  private async ensureOpen(): Promise<void> {
    if (this.opened) return;
    await this.wal.openWAL();
    this.opened = true;
  }

  /**
   * Commence a transaction to modify the database.
   */
  public async begin(): Promise<void> {
    return this.mutex.runExclusive(async () => {
      await this.ensureOpen();
      this.inTransaction = true;
    });
  }

  /**
   * Writes data to the WAL.
   * @param {number} offset a number >= 0, at which the data needs to be written in the database
   * @param {Uint8Array} data a Uint8Array with the data to be written to the database
   */
  public async journalWrite(offset: number, data: Uint8Array): Promise<void> {
    return this.mutex.runExclusive(async () => {
      if (!this.inTransaction) throw new Error('No active transaction.');
      await this.wal.logWrite(offset, data);
    });
  }

  /**
   * Reads a sequence of bytes from the database file.
   *
   * @param {number} offset a number >= 0, the byte position in the database file from which reading
   *               should begin.
   * @param {number} length a number >= 0, the number of bytes to read.
   * @returns {Uint8Array} A Uint8Array containing the read data from the database file.
   */
  public async read(offset: number, length: number): Promise<Uint8Array> {
    return this.mutex.runExclusive(async () => {
      await this.ensureOpen();
      const buf: Buffer = Buffer.alloc(length);
      await this.dbFile.read(buf, { position: offset });
      return new Uint8Array(buf);
    });
  }

  /**
   * Commits data to the WAL by adding a marker.
   */
  public async commitDataToWal(): Promise<void> {
    return this.mutex.runExclusive(async () => {
      if (!this.inTransaction) throw new Error('no active transaction');

      await this.wal.sync();
      await this.wal.addCommitMarker();
      await this.wal.sync();
    });
  }

  /**
   * Writes committed WAL data to the database and lets the WAL manager
   * finish the durability cycle.
   */
  public async checkpoint(): Promise<void> {
    return this.mutex.runExclusive(async () => {
      await this.ensureOpen();
      await this.wal.checkpoint();
      this.inTransaction = false;
    });
  }

  /**
   * Checks for a crash and recovers committed data in WAL, run on startup.
   */
  public async recover(): Promise<void> {
    return this.mutex.runExclusive(async () => {
      await this.ensureOpen();
      await this.wal.recover();
      this.inTransaction = false;
    });
  }

  /**
   * Aborts the active transaction and clears the WAL.
   */
  public async abort(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      await this.wal.clearLog();
      await this.wal.sync();
      this.inTransaction = false;
    });

    await this.safeShutdown();
  }

  /**
   * Shuts down atomic-file safely.
   */
  public async safeShutdown(): Promise<void> {
    return this.mutex.runExclusive(async () => {
      await this.dbFile.sync();
      await this.wal.sync();
      await this.wal.closeWAL();
      this.opened = false;
      this.inTransaction = false;
    });
  }

  /**
   * Opens the atomic file (alias for ensureOpen).
   */
  public async open(): Promise<void> {
    await this.ensureOpen();
  }

  /**
   * Closes the atomic file (alias for safeShutdown).
   */
  public async close(): Promise<void> {
    await this.safeShutdown();
  }

  // Helper functions for testing

  public getOpenAndInTransaction(): boolean {
    return this.opened && this.inTransaction;
  }

  /**
   * A helper for disk-storage.
   *
   * @returns {File} The associated dbfile
   */
  public getDBFile(): File {
    return this.dbFile;
  }
}
