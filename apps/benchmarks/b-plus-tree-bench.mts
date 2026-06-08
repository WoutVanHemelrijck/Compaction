import { performance } from 'perf_hooks';
import * as fsp from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

import { BPlusTree } from '../../packages/dbms/indexes/b-plus-tree.mjs';
import { FreeBlockFile } from '../../packages/dbms/storage/freeblockfile.mjs';
import {
  FBNodeStorage,
  FBLeafNode,
  FBInternalNode,
} from '../../packages/dbms/storage/node-storage/fb-node-storage.mjs';
import { RealFile, type File as DbFile } from '../../packages/dbms/storage/file/file.mjs';
import { MockFile } from '../../packages/dbms/storage/file/mockfile.mjs';
import { AtomicFileImpl } from '../../packages/dbms/durability/atomic-operations/atomic-file.mjs';
import { WALManagerImpl } from '../../packages/dbms/durability/atomic-operations/wal-manager.mjs';

type BenchLeaf = FBLeafNode<number, number>;
type BenchInternal = FBInternalNode<number, number>;
type BenchTree = BPlusTree<number, number, BenchLeaf, BenchInternal>;

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

type FileBackend = 'real' | 'mock';

async function makeTree(order = 32, backend: FileBackend = 'mock') {
  const compareKeys = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);
  const keySize = (_k: number) => 8;

  let dbFile: DbFile;
  let walFile: DbFile;
  let filePath: string | null = null;
  let walPath: string | null = null;

  if (backend === 'mock') {
    dbFile = new MockFile(512);
    walFile = new MockFile(512);
  } else {
    filePath = join(tmpdir(), `bpt-fb-${process.pid}-${randomUUID()}.db`);
    walPath = `${filePath}.wal`;

    dbFile = new RealFile(filePath);
    walFile = new RealFile(walPath);

    // RealFile.open() uses 'r+', so ensure files exist first.
    await dbFile.create();
    await dbFile.close();
    await walFile.create();
    await walFile.close();
  }

  const wal = new WALManagerImpl(walFile, dbFile);
  const atomicFile = new AtomicFileImpl(dbFile, wal);
  const fbFile = new FreeBlockFile(dbFile, atomicFile, 4096);
  await fbFile.open();

  const storage = new FBNodeStorage<number, number>(compareKeys, keySize, fbFile, order);
  const tree = new BPlusTree<number, number, BenchLeaf, BenchInternal>(storage, order);

  const dispose = async () => {
    await fbFile.close();
    if (filePath) await fsp.unlink(filePath).catch(() => {});
    if (walPath) await fsp.unlink(walPath).catch(() => {});
  };

  return { tree, storage, fbFile, dispose };
}

async function timeInsert(tree: BenchTree, fbFile: FreeBlockFile, keys: number[]) {
  const t0 = performance.now();
  for (const k of keys) {
    await tree.insert(k, k);
    await fbFile.commit();
  }
  const t1 = performance.now();
  return t1 - t0;
}

async function timeSearch(tree: BenchTree, keys: number[]) {
  const t0 = performance.now();
  for (const key of keys) {
    const found = await tree.search(key);
    if (found === null) {
      throw new Error(`Searched key not found during benchmark: ${key}`);
    }
  }
  const t1 = performance.now();
  return t1 - t0;
}

async function timeDelete(tree: BenchTree, fbFile: FreeBlockFile, keys: number[]) {
  const t0 = performance.now();
  for (const k of keys) {
    await tree.delete(k);
    await fbFile.commit();
  }
  const t1 = performance.now();
  return t1 - t0;
}

function printRow(n: number, insMs: number, srchMs: number, delMs: number) {
  const log2n = Math.log2(n);
  const insUs = (insMs / n) * 1000;
  const srchUs = (srchMs / n) * 1000;
  const delUs = (delMs / n) * 1000;
  console.log(
    `${n}\tlog2(n)=${log2n.toFixed(2)}\tinsert_total_ms=${insMs.toFixed(2)}\tinsert_us/op=${insUs.toFixed(
      3,
    )}\tsearch_total_ms=${srchMs.toFixed(2)}\tsearch_us/op=${srchUs.toFixed(3)}\tdelete_total_ms=${delMs.toFixed(
      2,
    )}\tdelete_us/op=${delUs.toFixed(3)}`,
  );
}

async function runOnce(n: number, opts: { mode: 'random' | 'sequential'; order?: number; backend?: FileBackend }) {
  const { tree, storage, fbFile, dispose } = await makeTree(opts.order ?? 32, opts.backend ?? 'mock');

  try {
    await tree.init();

    let keys: number[];
    if (opts.mode === 'sequential') {
      keys = Array.from({ length: n }, (_, i) => i);
    } else {
      keys = Array.from({ length: n }, (_, i) => i);
      shuffle(keys, 12345);
    }

    const insertMs = await timeInsert(tree, fbFile, keys);
    await storage.commitAndReclaim();

    const searchKeys = keys.slice();
    shuffle(searchKeys, 9999);
    const srchMs = await timeSearch(tree, searchKeys);

    const delMs = await timeDelete(tree, fbFile, keys);
    await storage.commitAndReclaim();

    return { n, insertMs, srchMs, delMs };
  } finally {
    await dispose();
  }
}

async function runSizes(
  sizes: number[],
  mode: 'random' | 'sequential',
  opts?: {
    totalRuns?: number;
    discardRuns?: number;
    summary?: 'median' | 'average';
    backend?: FileBackend;
  },
) {
  const totalRuns = opts?.totalRuns ?? 9;
  const discardRuns = opts?.discardRuns ?? 2;
  const summary = opts?.summary ?? 'median';

  if (discardRuns >= totalRuns) {
    throw new Error(`discardRuns (${discardRuns}) must be smaller than totalRuns (${totalRuns})`);
  }

  const summarize = summary === 'median' ? median : mean;

  console.log(
    `Using ${summary} of ${totalRuns - discardRuns} runs per size (discarding first ${discardRuns} warmup run(s))`,
  );
  console.log(
    'n\tlog2(n)\tinsert_total_ms\tinsert_us/op\tsearch_total_ms\tsearch_us/op\tdelete_total_ms\tdelete_us/op',
  );

  for (const n of sizes) {
    try {
      const insertArr: number[] = [];
      const searchArr: number[] = [];
      const deleteArr: number[] = [];

      for (let r = 0; r < totalRuns; r++) {
        const res = await runOnce(n, { mode, order: 32, backend: opts?.backend ?? 'mock' });

        // Discard full benchmark warmup runs to reduce JIT/cold-start spikes.
        if (r < discardRuns) continue;

        insertArr.push(res.insertMs);
        searchArr.push(res.srchMs);
        deleteArr.push(res.delMs);
      }

      printRow(n, summarize(insertArr), summarize(searchArr), summarize(deleteArr));
    } catch (err) {
      console.error('error running size', n, err);
      break;
    }
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main() {
  const sizes = [1000, 5000, 10000, 50000, 100000];
  const backend: FileBackend = process.argv.includes('--real') ? 'real' : 'mock';

  console.log(`Benchmark using FBNodeStorage + FreeBlockFile (backend=${backend})`);
  console.log('Mode: random inserts/searches');
  await runSizes(sizes, 'random', { totalRuns: 9, discardRuns: 2, summary: 'median', backend });

  console.log('\nMode: sequential inserts/searches');
  await runSizes(sizes, 'sequential', { totalRuns: 9, discardRuns: 2, summary: 'median', backend });

  console.log('\nDone.');
}

await main();

// Mode: random inserts/searches
// Using median of 7 runs per size (discarding first 2 warmup run(s))
// n       log2(n) insert_total_ms insert_us/op    search_total_ms search_us/op    delete_total_ms delete_us/op
// 1000    log2(n)=9.97    insert_total_ms=32.19   insert_us/op=32.194     search_total_ms=1.23    search_us/op=1.233      delete_total_ms=22.84   delete_us/op=22.837
// 5000    log2(n)=12.29   insert_total_ms=187.18  insert_us/op=37.437     search_total_ms=5.34    search_us/op=1.068      delete_total_ms=126.57  delete_us/op=25.314
// 10000   log2(n)=13.29   insert_total_ms=398.07  insert_us/op=39.807     search_total_ms=10.60   search_us/op=1.060      delete_total_ms=254.14  delete_us/op=25.414
// 50000   log2(n)=15.61   insert_total_ms=2180.48 insert_us/op=43.610     search_total_ms=65.64   search_us/op=1.313      delete_total_ms=1447.23 delete_us/op=28.945
// 100000  log2(n)=16.61   insert_total_ms=4310.00 insert_us/op=43.100     search_total_ms=140.23  search_us/op=1.402      delete_total_ms=2904.56 delete_us/op=29.046
// 500000  log2(n)=18.93   insert_total_ms=23472.53        insert_us/op=46.945     search_total_ms=923.60  search_us/op=1.847      delete_total_ms=15992.10        delete_us/op=31.984
// 1000000 log2(n)=19.93   insert_total_ms=50839.26        insert_us/op=50.839     search_total_ms=2311.86 search_us/op=2.312      delete_total_ms=34434.65        delete_us/op=34.435

// Mode: sequential inserts/searches
// Using median of 7 runs per size (discarding first 2 warmup run(s))
// n       log2(n) insert_total_ms insert_us/op    search_total_ms search_us/op    delete_total_ms delete_us/op
// 1000    log2(n)=9.97    insert_total_ms=30.79   insert_us/op=30.787     search_total_ms=0.68    search_us/op=0.679      delete_total_ms=29.26   delete_us/op=29.263
// 5000    log2(n)=12.29   insert_total_ms=175.73  insert_us/op=35.146     search_total_ms=4.66    search_us/op=0.933      delete_total_ms=158.69  delete_us/op=31.738
// 10000   log2(n)=13.29   insert_total_ms=364.97  insert_us/op=36.497     search_total_ms=9.74    search_us/op=0.974      delete_total_ms=319.56  delete_us/op=31.956
// 50000   log2(n)=15.61   insert_total_ms=1904.04 insert_us/op=38.081     search_total_ms=61.76   search_us/op=1.235      delete_total_ms=1758.61 delete_us/op=35.172
// 100000  log2(n)=16.61   insert_total_ms=3841.62 insert_us/op=38.416     search_total_ms=133.75  search_us/op=1.338      delete_total_ms=3547.30 delete_us/op=35.473
// 500000  log2(n)=18.93   insert_total_ms=19966.55        insert_us/op=39.933     search_total_ms=860.68  search_us/op=1.721      delete_total_ms=17781.71        delete_us/op=35.563
// 1000000 log2(n)=19.93   insert_total_ms=40201.31        insert_us/op=40.201     search_total_ms=1857.67 search_us/op=1.858      delete_total_ms=35054.60        delete_us/op=35.055
