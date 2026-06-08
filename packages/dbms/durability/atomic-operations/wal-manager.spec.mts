// @author Arwin Gorissen
// @date 2025-11-15

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockFile } from '../../storage/file/mockfile.mjs';
import { WALManagerImpl } from './wal-manager.mjs';

const BINARY_COMMIT_SIZE = 8;

describe('AtomicFile + WALManager integration (concurrency safe skeleton)', () => {
  let dbFile: MockFile;
  let walFile: MockFile;
  let wal: WALManagerImpl;
  let data: Uint8Array;
  let data2: Uint8Array;

  beforeEach(async () => {
    dbFile = new MockFile(512);
    walFile = new MockFile(512);
    await dbFile.create();
    await walFile.create();

    wal = new WALManagerImpl(walFile, dbFile);
    data = Uint8Array.from([9, 9, 9]);
    data2 = Uint8Array.from('Caligula');
  });

  afterEach(async () => {
    await wal.clearLog();
    await dbFile.truncate(0);
  });

  it('openWAL() and closeWAL() test', async () => {
    await wal.openWAL();
    expect(wal.getOpen()).toEqual(true);
    await wal.closeWAL();
    expect(wal.getOpen()).toEqual(false);
  });

  it('logWrite() test', async () => {
    // WRITE record header is 24 bytes: magic(4)+type(4)+offset(8)+length(4)+checksum(4)
    const WRITE_HEADER_SIZE = 24;

    //writes correctly to WAL
    await wal.logWrite(0, data);
    const buffer: Buffer = Buffer.alloc(data.length);
    await walFile.read(buffer, { position: WRITE_HEADER_SIZE });
    expect(buffer).toEqual(Buffer.from(data));

    //writes correctly to WAL if there is already data present
    await wal.logWrite(0, data2);
    const buffer2: Buffer = Buffer.alloc(data2.length);
    // second record starts at WRITE_HEADER_SIZE + data.length; its payload is another WRITE_HEADER_SIZE in
    const pos: number = data.length + WRITE_HEADER_SIZE * 2;
    await walFile.read(buffer, { position: WRITE_HEADER_SIZE });
    await walFile.read(buffer2, { position: pos });
    expect(buffer).toEqual(Buffer.from(data));
    expect(buffer2).toEqual(Buffer.from(data2));
  });

  it('addCommitMarker() test', async () => {
    const WRITE_HEADER_SIZE = 24;

    await wal.logWrite(0, Uint8Array.from(data));
    await wal.addCommitMarker();

    //after commit the WAL contains the data followed by a binary commit record
    const out: Buffer = Buffer.alloc(data.length);
    await walFile.read(out, { position: WRITE_HEADER_SIZE });
    const marker: Buffer = Buffer.alloc(BINARY_COMMIT_SIZE);
    await walFile.read(marker, { position: WRITE_HEADER_SIZE + data.length });

    expect(out).toEqual(Buffer.from(data));
    expect(marker.length).toEqual(BINARY_COMMIT_SIZE);

    await wal.clearLog();

    //also works after multiple writes
    await wal.logWrite(0, data);
    await wal.logWrite(0, data2);
    await wal.addCommitMarker();
    const marker2: Buffer = Buffer.alloc(BINARY_COMMIT_SIZE);
    // commit record follows two WRITE records
    const pos: number = WRITE_HEADER_SIZE * 2 + data.length + data2.length;
    await walFile.read(marker2, { position: pos });

    expect(marker2.length).toEqual(BINARY_COMMIT_SIZE);
  });

  it('checkpoint() test1: seperate writes to database', async () => {
    await wal.logWrite(0, Uint8Array.from(data));
    await wal.addCommitMarker();
    await wal.checkpoint();

    //database contains committed data
    const buffer: Buffer = Buffer.alloc(data.length);
    await dbFile.read(buffer, { position: 0 });
    expect(buffer).toEqual(Buffer.from(data));

    await wal.logWrite(0, Uint8Array.from(data2));
    await wal.addCommitMarker();
    await wal.checkpoint();

    //database contains new committed data and data already committed remains unchanged
    const buffer2: Buffer = Buffer.alloc(data2.length);
    await dbFile.read(buffer2, { position: data.length });
    expect(buffer2).toEqual(Buffer.from(data2));
  });

  it('checkpoint() test2: one write to database, multiple commits to WAL', async () => {
    await wal.logWrite(0, Uint8Array.from(data));
    await wal.addCommitMarker();
    await wal.logWrite(data.length, Uint8Array.from(data2));
    await wal.addCommitMarker();
    await wal.checkpoint();

    const buffer: Buffer = Buffer.alloc(Buffer.from(data).length);
    await dbFile.read(buffer, { position: 0 });
    const buffer2: Buffer = Buffer.alloc(Buffer.from(data2).length);
    await dbFile.read(buffer2, { position: Buffer.from(data).length });

    //database contains committed data
    expect(buffer).toEqual(Buffer.from(data));
    expect(buffer2).toEqual(Buffer.from(data2));
  });

  it('checkpoint() test3: one write to database; one commit to WAL from multiple data writes', async () => {
    await wal.logWrite(0, Uint8Array.from(data));
    await wal.logWrite(data.length, Uint8Array.from(data2));
    await wal.addCommitMarker();
    await wal.checkpoint();

    const buffer: Buffer = Buffer.alloc(data.length);
    await dbFile.read(buffer, { position: 0 });
    const buffer2: Buffer = Buffer.alloc(data2.length);
    await dbFile.read(buffer2, { position: Buffer.from(data).length });

    //database contains committed data
    expect(buffer).toEqual(Buffer.from(data));
    expect(buffer2).toEqual(Buffer.from(data2));
  });

  it('checkpoint() test4: checksum test', async () => {
    const WRITE_HEADER_SIZE = 24;
    await wal.logWrite(0, Uint8Array.from(data2));
    await wal.logWrite(data.length, Uint8Array.from(data2));
    await wal.addCommitMarker();
    //corrupt data in WAL
    await walFile.writev([Buffer.from(data)], WRITE_HEADER_SIZE);
    await wal.checkpoint();

    //nothing should be written to database and WAL should be flushed
    const dbStat = await dbFile.stat();
    expect(dbStat.size).toBe(0);
  });

  it('checkpoint() keeps earlier committed transactions when a later record is corrupted', async () => {
    const WRITE_HEADER_SIZE = 24;

    // First transaction is valid and committed.
    await wal.logWrite(0, Uint8Array.from([1, 2, 3]));
    await wal.addCommitMarker();

    // Second transaction is also committed, but we corrupt its payload afterwards.
    await wal.logWrite(3, Uint8Array.from([4, 5, 6]));
    await wal.addCommitMarker();

    const secondPayloadPos = WRITE_HEADER_SIZE + 3 + BINARY_COMMIT_SIZE + WRITE_HEADER_SIZE;
    await walFile.writev([Buffer.from([9, 9, 9])], secondPayloadPos);

    await wal.checkpoint();

    const first = Buffer.alloc(3);
    const second = Buffer.alloc(3);
    await dbFile.read(first, { position: 0 });
    await dbFile.read(second, { position: 3 });

    // First committed transaction must still be replayed.
    expect(Array.from(first)).toEqual([1, 2, 3]);
    // Corrupted later transaction must not be replayed.
    expect(Array.from(second)).toEqual([0, 0, 0]);
  });

  it('Recover() test1: drops uncommitted WAL entries (no commit marker)', async () => {
    // write a log entry but do NOT add commit marker
    await wal.logWrite(16, Uint8Array.from([9, 9, 9]));

    // call recover via an AtomicFile wrapper (recover will clear WAL if no COMMIT)
    await wal.recover();

    // WAL should be cleared and DB untouched
    const walStat: { size: number } = await walFile.stat();
    const dbStat: { size: number } = await dbFile.stat();
    expect(walStat.size).toBe(0);
    expect(dbStat.size).toBe(0);
  });

  it('Recover() test2: applies committed WAL entries but not uncommitted ones', async () => {
    // write entry and commit marker (simulate a crash)
    await wal.logWrite(0, Uint8Array.from([7, 8]));
    await wal.addCommitMarker();
    await wal.logWrite(0, Uint8Array.from(data));

    await wal.recover();

    // committed writes should be applied to DB but uncommitted writes should not be
    const out: Buffer = Buffer.alloc(2);
    const out2: Buffer = Buffer.alloc(data.length);
    await dbFile.read(out, { position: 0 });
    await dbFile.read(out2, { position: Buffer.from([7, 8]).length });

    expect(Array.from(out)).toEqual([7, 8]);
    expect(Array.from(out2)).toEqual([0, 0, 0]);

    // WAL should be cleared after successful recovery
    const walStat: { size: number } = await walFile.stat();
    expect(walStat.size).toBe(0);
  });

  it('clearLog() test', async () => {
    await wal.logWrite(0, Uint8Array.from(data));
    await wal.clearLog();
    const walStat: { size: number } = await walFile.stat();
    expect(walStat.size).toBe(0);
  });

  it('keeps WAL size at or below 100 MB by auto-checkpointing', async () => {
    const WAL_SIZE_LIMIT = 100 * 1024 * 1024;
    const chunkSize = 1024 * 1024;
    const chunk = new Uint8Array(chunkSize);

    // Push enough committed data to force at least one automatic checkpoint.
    for (let i = 0; i < 140; i++) {
      await wal.logWrite(i * chunkSize, chunk);
      await wal.addCommitMarker();

      const walStat = await walFile.stat();
      expect(walStat.size).toBeLessThanOrEqual(WAL_SIZE_LIMIT);
    }
  }, 60000);
});
