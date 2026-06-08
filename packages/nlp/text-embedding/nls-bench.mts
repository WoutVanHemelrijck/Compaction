// @author Arwin Gorissen
// @date 2025-05-10

import { hnswIndexImpl } from './hnsw-index.mjs';
import fs from 'fs/promises';
import path from 'path';
import { FreeBlockFile } from '../../dbms/storage/freeblockfile.mjs';
import type { File as FileInterface } from '../../dbms/storage/file/file.mjs';
import { AtomicFile } from '../../dbms/storage/freeblockfile.mjs';
import { MockFile } from '../../dbms/storage/file/mockfile.mjs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';

type CsvRow = {
  answers: string;
  passages: string;
  query: string;
  query_id: string;
  query_type: string;
  wellFormedAnswers: string;
};

interface BenchmarkResult {
  layerCount: number;
  M: number;
  efConstruction: number;
  efSearch: number;
  /** Average correct hits over 10 runs */
  correct1: number;
  /** Average correct hits over 10 runs */
  correct5: number;
  /** Average total build time in ms over 10 runs */
  buildTimeMs: number;
  /** p50 query latency in ms (averaged over 10 runs) */
  p50: number;
  /** p95 query latency in ms (averaged over 10 runs) */
  p95: number;
  /** p99 query latency in ms (averaged over 10 runs) */
  p99: number;
}

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
  const fb = new FreeBlockFile(mf as unknown as FileInterface, atomic as unknown as AtomicFile, 4096 * 4);
  await fb.open();
  return { fb, mf, atomic };
}

function extractFirstStringArrayValue(input: string): string {
  try {
    const cleaned = input.replace(/^"\[/, '[').replace(/\]"$/, ']').replace(/'/g, '"');
    const arr = JSON.parse(cleaned) as unknown;
    return Array.isArray(arr) ? String(arr[0]) : '';
  } catch {
    return '';
  }
}

function parseCsv(content: string): CsvRow[] {
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const values: string[] = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || [];
    const row: Record<string, string | undefined> = {};
    headers.forEach((h, i) => {
      row[h.replace(/"/g, '')] = values[i];
    });
    return row as CsvRow;
  });
}

async function makeHNSW(
  layerCount: number,
  M: number,
  Mmax: number,
  efConstruction: number,
  efSearch: number,
): Promise<hnswIndexImpl> {
  const { fb } = await makeFreeBlockFile();
  const { fb: fb2 } = await makeFreeBlockFile();
  const file = new MockFile(512);
  await file.create();
  const hnsw = new hnswIndexImpl(layerCount, M, Mmax, efConstruction, efSearch, fb, fb2, file);
  await hnsw.init();
  await hnsw.open();
  return hnsw;
}

function percentile(sortedMs: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sortedMs.length) - 1;
  return sortedMs[Math.max(0, idx)];
}

async function runConfiguration(
  insertCount: number,
  layerCount: number,
  M: number,
  efConstruction: number,
  efSearch: number,
  rows: CsvRow[],
  RUNS = 10,
): Promise<BenchmarkResult> {
  const Mmax = 2 * M;

  let totalCorrect1 = 0;
  let totalCorrect5 = 0;
  let totalBuildMs = 0;
  const allQueryLatencies: number[] = [];

  for (let run = 0; run < RUNS; run++) {
    const hnsw = await makeHNSW(layerCount, M, Mmax, efConstruction, efSearch);
    const idMap = new Map<string, number>();

    const buildStart = performance.now();

    for (let i = 0; i < Math.min(insertCount, rows.length); i++) {
      const id = randomUUID();
      const passage = extractFirstStringArrayValue(rows[i].query);
      if (!passage) continue;
      await hnsw.insert(passage, id);
      idMap.set(id, i);
    }

    totalBuildMs += performance.now() - buildStart;

    let correct1 = 0;
    let correct5 = 0;
    let i = 0;

    for (const row of rows) {
      if (i >= insertCount) break;
      const query = extractFirstStringArrayValue(row.answers);
      if (!query) {
        i++;
        continue;
      }

      const t0 = performance.now();
      const res = await hnsw.search(query, 5);
      allQueryLatencies.push(performance.now() - t0);

      if (res.length > 0 && idMap.get(res[0]) === i) {
        correct1++;
      }

      for (const r of res) {
        if (idMap.get(r) === i) {
          correct5++;
          break;
        }
      }

      i++;
    }

    totalCorrect5 += correct5;
    totalCorrect1 += correct1;
  }

  allQueryLatencies.sort((a, b) => a - b);

  return {
    layerCount,
    M,
    efConstruction,
    efSearch,
    correct1: totalCorrect1 / RUNS,
    correct5: totalCorrect5 / RUNS,
    buildTimeMs: totalBuildMs / RUNS,
    p50: percentile(allQueryLatencies, 50),
    p95: percentile(allQueryLatencies, 95),
    p99: percentile(allQueryLatencies, 99),
  };
}

function resultsToCsv(results: Array<BenchmarkResult & { insertCount: number }>): string {
  const header = [
    'insertCount',
    'layerCount',
    'M',
    'efConstruction',
    'efSearch',
    'correct1',
    'correct5',
    'buildTimeMs',
    'p50_ms',
    'p95_ms',
    'p99_ms',
  ].join(',');

  const rows = results.map((r) =>
    [
      r.insertCount,
      r.layerCount,
      r.M,
      r.efConstruction,
      r.efSearch,
      r.correct1.toFixed(2),
      r.correct5.toFixed(2),
      r.buildTimeMs.toFixed(2),
      r.p50.toFixed(3),
      r.p95.toFixed(3),
      r.p99.toFixed(3),
    ].join(','),
  );

  return [header, ...rows].join('\n');
}

//PARAMETERS FOR BENCH
const LAYER_COUNTS = [4];
const M_VALUES = [48];
const EF_CONSTRUCTIONS = [64];
const EF_SEARCHES = [64];
const INSERT_COUNTS = [
  10, 20, 50, 75, 100, 125, 150, 175, 200, 250, 350, 500, 650, 800, 1000, 1500, 2000, 3000, 5000, 7500, 9500,
];
const RUNS = 20;

async function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.resolve(__dirname, './test.csv');

  console.log(`Reading CSV from ${filePath}…`);
  const content = await fs.readFile(filePath, 'utf-8');
  const rows = parseCsv(content);
  console.log(`Loaded ${rows.length} rows.\n`);

  const results: Array<BenchmarkResult & { insertCount: number }> = [];

  const totalConfigs =
    INSERT_COUNTS.length * LAYER_COUNTS.length * M_VALUES.length * EF_CONSTRUCTIONS.length * EF_SEARCHES.length;

  let done = 0;

  for (const insertCount of INSERT_COUNTS) {
    for (const layerCount of LAYER_COUNTS) {
      for (const M of M_VALUES) {
        for (const efConstruction of EF_CONSTRUCTIONS) {
          for (const efSearch of EF_SEARCHES) {
            done++;
            process.stdout.write(
              `[${done}/${totalConfigs}] insertCount=${insertCount} layerCount=${layerCount} M=${M} efC=${efConstruction} efS=${efSearch} … `,
            );

            const result = await runConfiguration(insertCount, layerCount, M, efConstruction, efSearch, rows, RUNS);

            results.push({ insertCount, ...result });

            console.log(
              `correct1=${result.correct1.toFixed(1)} buildMs=${result.buildTimeMs.toFixed(0)} p50=${result.p50.toFixed(2)}ms p95=${result.p95.toFixed(2)}ms`,
            );
            console.log(
              `correct5=${result.correct5.toFixed(1)} buildMs=${result.buildTimeMs.toFixed(0)} p50=${result.p50.toFixed(2)}ms p95=${result.p95.toFixed(2)}ms`,
            );
          }
        }
      }
    }
  }

  const csvContent = resultsToCsv(results);
  const outPath = path.resolve(__dirname, './bench_results.csv');
  await fs.writeFile(outPath, csvContent, 'utf-8');

  console.log(`\n✅  Results written to ${outPath}`);
  console.log(`   ${results.length} rows × ${RUNS} runs each.`);
  console.table(results);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
