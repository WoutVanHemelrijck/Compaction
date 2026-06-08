// @author Arwin Gorissen
// @date 2025-05-10

import { SearchEngine } from './search-engine.mjs';
import { BPlusTree } from '../../dbms/indexes/b-plus-tree.mjs';
import { NgramIndex } from './ngram-index.mjs';
import {
  TrivialNodeStorage,
  TrivialLeafNode,
  TrivialInternalNode,
} from '../../dbms/storage/node-storage/trivial-node-storage.mjs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

type DocID = number;

type CsvRow = {
  answers: string;
  passages: string;
  query: string;
  query_id: string;
  query_type: string;
  wellFormedAnswers: string;
};

type BenchmarkResult = {
  count: number;
  insertTimeMs: number;
  insertThroughputDocsPerSec: number;
  avgInsertTimePerDocMs: number;
  searchCorrect: number;
  searchTotal: number;
  accuracyPct: number;
  avgSearchTimeMs: number;
  minSearchTimeMs: number;
  maxSearchTimeMs: number;
  p50SearchTimeMs: number;
  p95SearchTimeMs: number;
};

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

function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
}

function buildFreshIndex() {
  const storage = new TrivialNodeStorage<string, Map<DocID, number>>(
    (a, b) => a.localeCompare(b),
    (key) => key.length,
  );
  const bplustree = new BPlusTree<
    string,
    Map<DocID, number>,
    TrivialLeafNode<string, Map<DocID, number>>,
    TrivialInternalNode<string, Map<DocID, number>>
  >(storage, 3);
  return { bplustree, storage };
}

async function runBenchmark(rows: CsvRow[], count: number): Promise<BenchmarkResult> {
  const { bplustree } = buildFreshIndex();
  await bplustree.init();

  const ngramindex = new NgramIndex<
    TrivialLeafNode<string, Map<DocID, number>>,
    TrivialInternalNode<string, Map<DocID, number>>
  >(bplustree);

  const searchEngine = new SearchEngine<
    TrivialLeafNode<string, Map<DocID, number>>,
    TrivialInternalNode<string, Map<DocID, number>>
  >(ngramindex);

  const insertStart = performance.now();
  let inserted = 0;

  for (let i = 0; i < rows.length && inserted < count; i++) {
    const passage = extractFirstStringArrayValue(rows[i].query);
    if (!passage) continue;
    await ngramindex.addDocument(inserted, passage);
    inserted++;
  }

  const insertTimeMs = performance.now() - insertStart;
  const insertThroughputDocsPerSec = inserted > 0 ? (inserted / insertTimeMs) * 1000 : 0;
  const avgInsertTimePerDocMs = inserted > 0 ? insertTimeMs / inserted : 0;

  let correct = 0;
  let searchTotal = 0;
  const searchTimes: number[] = [];

  let docIdx = 0;
  for (let i = 0; docIdx < count; i++) {
    const passage = extractFirstStringArrayValue(rows[i].query);
    if (!passage) {
      docIdx++;
      continue;
    }

    const query = extractFirstStringArrayValue(rows[i].answers);
    docIdx++;

    if (!query) continue;

    const t0 = performance.now();
    const res = await searchEngine.search(query, 'eng');
    searchTimes.push(performance.now() - t0);
    searchTotal++;

    if (res === docIdx - 1) {
      correct++;
    }
  }

  searchTimes.sort((a, b) => a - b);
  const avgSearchTimeMs = searchTimes.length > 0 ? searchTimes.reduce((s, v) => s + v, 0) / searchTimes.length : 0;

  return {
    count: inserted,
    insertTimeMs,
    insertThroughputDocsPerSec,
    avgInsertTimePerDocMs,
    searchCorrect: correct,
    searchTotal,
    accuracyPct: searchTotal > 0 ? (correct / searchTotal) * 100 : 0,
    avgSearchTimeMs,
    minSearchTimeMs: searchTimes[0] ?? 0,
    maxSearchTimeMs: searchTimes[searchTimes.length - 1] ?? 0,
    p50SearchTimeMs: percentile(searchTimes, 50),
    p95SearchTimeMs: percentile(searchTimes, 95),
  };
}

function resultsToCsv(results: BenchmarkResult[]): string {
  const headers = [
    'count',
    'insertTimeMs',
    'insertThroughputDocsPerSec',
    'avgInsertTimePerDocMs',
    'searchCorrect',
    'searchTotal',
    'accuracyPct',
    'avgSearchTimeMs',
    'minSearchTimeMs',
    'maxSearchTimeMs',
    'p50SearchTimeMs',
    'p95SearchTimeMs',
  ];

  const rows = results.map((r) =>
    [
      r.count,
      r.insertTimeMs.toFixed(3),
      r.insertThroughputDocsPerSec.toFixed(3),
      r.avgInsertTimePerDocMs.toFixed(3),
      r.searchCorrect,
      r.searchTotal,
      r.accuracyPct.toFixed(2),
      r.avgSearchTimeMs.toFixed(3),
      r.minSearchTimeMs.toFixed(3),
      r.maxSearchTimeMs.toFixed(3),
      r.p50SearchTimeMs.toFixed(3),
      r.p95SearchTimeMs.toFixed(3),
    ].join(','),
  );

  return [headers.join(','), ...rows].join('\n');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.resolve(__dirname, '../text-embedding/test.csv');
const content = await fs.readFile(filePath, 'utf-8');
const rows = parseCsv(content);
const counts = [
  10, 20, 50, 75, 100, 125, 150, 175, 200, 250, 350, 500, 650, 800, 1000, 1500, 2000, 3000, 5000, 7500, 9500,
];
console.log(`Running benchmarks for counts: ${counts.join(', ')}\n`);

const results: BenchmarkResult[] = [];

for (const count of counts) {
  process.stdout.write(`  count=${count} … `);
  const result = await runBenchmark(rows, count);
  results.push(result);
  console.log(
    `done — insert ${result.insertTimeMs.toFixed(0)} ms | accuracy ${result.accuracyPct.toFixed(1)}% | avg search ${result.avgSearchTimeMs.toFixed(2)} ms`,
  );
}

const csv = resultsToCsv(results);
const outPath = path.resolve(__dirname, './benchmark_results.csv');
await fs.writeFile(outPath, csv, 'utf-8');

console.log(`\nResults written to ${outPath}`);
