import * as fsp from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { setTimeout as sleep } from 'timers/promises';
import { BPlusTree } from '../../packages/dbms/indexes/b-plus-tree.mjs';
import {
  FBNodeStorage,
  FBLeafNode,
  FBInternalNode,
} from '../../packages/dbms/storage/node-storage/fb-node-storage.mjs';
import { FreeBlockFile } from '../../packages/dbms/storage/freeblockfile.mjs';
import { MockFile } from '../../packages/dbms/storage/file/mockfile.mjs';
import { RealFile, type File as DbFile } from '../../packages/dbms/storage/file/file.mjs';
import { AtomicFileImpl } from '../../packages/dbms/durability/atomic-operations/atomic-file.mjs';
import { WALManagerImpl } from '../../packages/dbms/durability/atomic-operations/wal-manager.mjs';

//import { debug_checkInvariants } from '../invariants.mjs';

const TEST = 8;

function xorshift32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
}

function shuffle<T>(arr: T[], seed = 42) {
  const rnd = xorshift32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rnd() % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

class TestAtomicFile {
  private inTransaction = false;
  private stagedWrites: { position: number; buffer: Buffer }[] = [];
  private opened = false;

  constructor(private file: MockFile) {}

  async open(): Promise<void> {
    await this.file.open();
  }

  async close(): Promise<void> {
    await this.file.close();
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
    // Write all staged writes to the file
    for (const { position, buffer } of this.stagedWrites) {
      await this.file.writev([buffer], position);
    }
    this.stagedWrites = [];
    this.inTransaction = false;
  }

  getOpenAndInTransaction(): boolean {
    return this.inTransaction && this.opened;
  }

  async sync(): Promise<void> {
    // No-op for MockFile
  }
}

type FileBackend = 'real' | 'mock';

function nowNs(): bigint {
  return process.hrtime.bigint();
}

function nsToMs(ns: bigint): number {
  return Number(ns) / 1_000_000;
}

async function makeTree(order = TEST, backend: FileBackend = 'real') {
  let dbFile: DbFile;
  let walFile: DbFile;
  let tmpDbPath: string | null = null;
  let tmpWalPath: string | null = null;

  if (backend === 'mock') {
    dbFile = new MockFile(512);
    walFile = new MockFile(512);
    await dbFile.open();
    await walFile.open();
  } else {
    tmpDbPath = join(tmpdir(), `fb-bench-${process.pid}-${randomUUID()}.db`);
    tmpWalPath = `${tmpDbPath}.wal`;
    dbFile = new RealFile(tmpDbPath);
    walFile = new RealFile(tmpWalPath);
    await dbFile.create();
    await dbFile.close();
    await walFile.create();
    await walFile.close();
  }

  const atomic =
    backend === 'mock'
      ? new TestAtomicFile(dbFile as MockFile)
      : new AtomicFileImpl(dbFile, new WALManagerImpl(walFile, dbFile));
  const fb = new FreeBlockFile(dbFile, atomic, 4096);
  await fb.open();

  const compareKeys = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);
  const keySize = (_k: number) => 8;
  const storage = new FBNodeStorage<number, number>(compareKeys, keySize, fb, TEST, 0);
  const tree = new BPlusTree<number, number, FBLeafNode<number, number>, FBInternalNode<number, number>>(
    storage,
    order,
  );

  const dispose = async () => {
    await fb.close();
    if (tmpDbPath) await fsp.unlink(tmpDbPath).catch(() => {});
    if (tmpWalPath) await fsp.unlink(tmpWalPath).catch(() => {});
  };

  return { tree, storage, dispose };
}

async function timePrefill(
  tree: BPlusTree<number, number, FBLeafNode<number, number>, FBInternalNode<number, number>>,
  storage: FBNodeStorage<number, number>,
  keys: number[],
  commitEvery: number,
) {
  const t0 = nowNs();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    await tree.insert(key, key);
    if (commitEvery > 0 && (i + 1) % commitEvery === 0) {
      await storage.commitAndReclaim();
    }
  }
  if (commitEvery > 0) {
    await storage.commitAndReclaim();
  }
  const t1 = nowNs();

  //
  //debug_checkInvariants(tree);
  //
  return nsToMs(t1 - t0);
}

async function timeInsertSearchDelete(
  tree: BPlusTree<number, number, FBLeafNode<number, number>, FBInternalNode<number, number>>,
  storage: FBNodeStorage<number, number>,
  initialKeys: number[],
  opCount: number,
  commitEvery: number,
) {
  const activeKeys = initialKeys.slice();
  const rand = xorshift32(987654321);
  let nextKey = initialKeys.length;

  //tree.ascii();

  let insertMs = 0;
  let searchMs = 0;
  let deleteMs = 0;

  //debug_checkInvariants(tree);
  //
  for (let i = 0; i < opCount; i++) {
    // INSERT
    const insertedKey = nextKey++;
    const insertT0 = nowNs();
    await tree.insert(insertedKey, insertedKey);
    const insertT1 = nowNs();
    insertMs += nsToMs(insertT1 - insertT0);
    activeKeys.push(insertedKey);
    //debug_checkInvariants(tree);
    //

    // SEARCH
    const searchIndex = rand() % activeKeys.length;
    const searchKey = activeKeys[searchIndex];
    const searchT0 = nowNs();
    const found = await tree.search(searchKey);
    const searchT1 = nowNs();
    searchMs += nsToMs(searchT1 - searchT0);
    if (found === null) {
      throw new Error(`Searched key not found during benchmark: ${searchKey}, found ${found} instead`);
    }
    if (activeKeys.length === 0) {
      throw new Error('No key available to delete during insert/delete benchmark pair');
    }
    //

    // DELETE
    const deleteIndex = rand() % activeKeys.length;
    const keyToDelete = activeKeys[deleteIndex];

    const deleteT0 = nowNs();
    await tree.delete(keyToDelete);
    const deleteT1 = nowNs();
    deleteMs += nsToMs(deleteT1 - deleteT0);

    const index = activeKeys.indexOf(keyToDelete);
    if (index > -1) {
      // only splice array when item is found
      activeKeys.splice(index, 1); // 2nd parameter means remove one item only
    }
    // const lastIndex = activeKeys.length - 1;
    // const lastKey = activeKeys[lastIndex];
    // if (deleteIndex !== lastIndex) {
    //   activeKeys[deleteIndex] = lastKey;
    // }
    // activeKeys.pop();
    //debug_checkInvariants(tree);
    //

    if (commitEvery > 0 && (i + 1) % commitEvery === 0) {
      await storage.commitAndReclaim();
    }
  }

  if (commitEvery > 0) {
    await storage.commitAndReclaim();
  }

  return {
    insertMs,
    searchMs,
    deleteMs,
  };
}

function printRowFromUs(n: number, insertUs: number, searchUs: number, deleteUs: number) {
  const log2n = Math.log2(n);
  console.log(
    `${n}\tlog2(n)=${log2n.toFixed(2)}\tinsert_us/op=${insertUs.toFixed(3)}\tsearch_us/op=${searchUs.toFixed(
      3,
    )}\tdelete_us/op=${deleteUs.toFixed(3)}`,
  );
}

async function runOnce(
  n: number,
  opts: { mode: 'random' | 'sequential'; order?: number; commitEvery?: number; backend?: FileBackend },
) {
  const { tree, storage, dispose } = await makeTree(opts.order ?? TEST, opts.backend ?? 'real');
  const commitEvery = opts.commitEvery ?? 1000;

  try {
    await tree.init();

    const keys = Array.from({ length: n }, (_, i) => i);
    if (opts.mode !== 'sequential') {
      shuffle(keys, 12345);
    }

    await timePrefill(tree, storage, keys, commitEvery);
    const opCount = n;
    const { insertMs, searchMs, deleteMs } = await timeInsertSearchDelete(tree, storage, keys, opCount, commitEvery);

    await storage.commitAndReclaim();
    return { n, insertMs, searchMs, deleteMs, opCount };
  } finally {
    await dispose();
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function runSizes(
  sizes: number[],
  mode: 'random' | 'sequential',
  opts?: {
    totalRuns?: number;
    discardRuns?: number;
    summary?: 'median' | 'average';
    commitEvery?: number;
    coolDownMs?: number;
    backend?: FileBackend;
  },
) {
  const totalRuns = opts?.totalRuns ?? 9;
  const discardRuns = opts?.discardRuns ?? 2;
  const summary = opts?.summary ?? 'median';
  const coolDownMs = opts?.coolDownMs ?? 200;
  const canForceGc = typeof global.gc === 'function';

  if (discardRuns >= totalRuns) {
    throw new Error(`discardRuns (${discardRuns}) must be smaller than totalRuns (${totalRuns})`);
  }

  const summarize = summary === 'median' ? median : mean;
  if (!canForceGc) {
    console.warn('global.gc is unavailable. Run node with --expose-gc to force GC between benchmark runs.');
  }
  console.log('n\tlog2(n)\tinsert_us/op\tsearch_us/op\tdelete_us/op');

  for (const n of sizes) {
    try {
      const insertArr: number[] = [];
      const searchArr: number[] = [];
      const deleteArr: number[] = [];

      for (let r = 0; r < totalRuns; r++) {
        if (typeof global.gc === 'function') {
          global.gc();
        }

        console.log(`Running size ${n}, run ${r + 1}/${totalRuns}...`);

        const res = await runOnce(n, {
          mode,
          order: TEST,
          commitEvery: opts?.commitEvery ?? 1000,
          backend: opts?.backend ?? 'real',
        });

        const insertUs = (res.insertMs / res.opCount) * 1000;
        const searchUs = (res.searchMs / res.opCount) * 1000;
        const deleteUs = (res.deleteMs / res.opCount) * 1000;

        if (r < discardRuns) continue;

        insertArr.push(insertUs);
        searchArr.push(searchUs);
        deleteArr.push(deleteUs);

        if (typeof global.gc === 'function') {
          global.gc();
        }
        await sleep(coolDownMs);
      }

      printRowFromUs(n, summarize(insertArr), summarize(searchArr), summarize(deleteArr));
    } catch (err) {
      console.error('error running size', n, err);
      break;
    }
  }
}

/**
 * NOTE:
 * This benchmark can force garbage collection between runs only when Node is
 * started with `--expose-gc` (so `global.gc` exists). Without that flag, the
 * benchmark still runs, but GC timing/noise may vary more between runs.
 */
async function main() {
  const sizes = [1000, 2500, 5000, 7500, 10000, 25000, 50000, 75000, 100000];
  const totalRuns = 11;
  const discardRuns = 5;
  const summary: 'median' | 'average' = 'median';
  const commitEvery = 1;
  const coolDownMs = 300;
  const backend: FileBackend = process.argv.includes('--mock') ? 'mock' : 'real';

  const warmupRuns = 10;
  for (let i = 0; i < warmupRuns; i++) {
    await runOnce(1000, { mode: 'random', order: TEST, commitEvery, backend });
    console.log(`Warmup run ${i + 1}/${warmupRuns} completed.`);
  }

  console.log('Mode: random prefill order');
  await runSizes(sizes, 'random', { totalRuns, discardRuns, summary, commitEvery, coolDownMs, backend });

  //console.log('\nMode: sequential prefill order');
  //await runSizes(sizes, 'sequential', { totalRuns, discardRuns, summary, commitEvery, coolDownMs, backend });

  console.log('\nDone.');
}

await main();
