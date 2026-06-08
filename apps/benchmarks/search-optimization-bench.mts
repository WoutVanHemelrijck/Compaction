import { performance } from 'node:perf_hooks';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { SimpleDBMS, type Collection, type Query } from '../../packages/dbms/core/simpledbms.mjs';
import { MockFile } from '../../packages/dbms/storage/file/mockfile.mjs';

type CaseName = 'exactIdLookup' | 'shortRangeScan' | 'indexedFilterQuery';

type CaseSummary = {
  samplesMs: number[];
  medianMs: number;
  operations: number;
  msPerOp: number;
  opsPerSecond: number;
};

type BenchmarkReport = {
  benchmark: 'search-optimization';
  timestamp: string;
  environment: {
    node: string;
    platform: string;
    arch: string;
  };
  config: {
    profile: 'quick' | 'full';
    maxRuntimeMs: number;
    documentCount: number;
    runsPerCase: number;
    warmupRuns: number;
    idLookupsPerRun: number;
    rangeQueriesPerRun: number;
    indexedQueriesPerRun: number;
    rangeWidth: number;
  };
  cases: Record<CaseName, CaseSummary>;
};

type BenchConfig = {
  profile: 'quick' | 'full';
  maxRuntimeMs: number;
  documentCount: number;
  runsPerCase: number;
  warmupRuns: number;
  idLookupsPerRun: number;
  rangeQueriesPerRun: number;
  indexedQueriesPerRun: number;
  rangeWidth: number;
};

const QUICK_CONFIG: BenchConfig = {
  profile: 'quick',
  maxRuntimeMs: 60_000,
  documentCount: 2_000,
  runsPerCase: 2,
  warmupRuns: 0,
  idLookupsPerRun: 500,
  rangeQueriesPerRun: 80,
  indexedQueriesPerRun: 80,
  rangeWidth: 48,
};

const FULL_CONFIG: BenchConfig = {
  profile: 'full',
  maxRuntimeMs: 60_000,
  documentCount: 25_000,
  runsPerCase: 7,
  warmupRuns: 1,
  idLookupsPerRun: 4_000,
  rangeQueriesPerRun: 1_200,
  indexedQueriesPerRun: 1_200,
  rangeWidth: 96,
};

function xorshift32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function parseArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function fmtMs(value: number): string {
  return `${value.toFixed(3)} ms`;
}

function fmtPct(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

async function setupCollection(documentCount: number): Promise<Collection> {
  const dbFile = new MockFile(512);
  const walFile = new MockFile(512);
  const heapFile = new MockFile(512);
  const heapWalFile = new MockFile(512);

  const db = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);
  const collection = await db.createCollection('bench_users');

  const statuses = ['active', 'inactive', 'pending', 'blocked'];
  const tiers = ['free', 'pro', 'enterprise'];
  const rand = xorshift32(123456789);

  for (let i = 0; i < documentCount; i++) {
    const id = `doc_${i.toString().padStart(8, '0')}`;
    const score = rand() % 1000;
    const age = 18 + (rand() % 63);
    const status = statuses[rand() % statuses.length];
    const tier = tiers[rand() % tiers.length];

    await collection.insert({
      id,
      status,
      tier,
      score,
      age,
      regionCode: rand() % 32,
    });
  }

  return collection;
}

function enforceTimeBudget(startMs: number, config: BenchConfig, stage: string): void {
  const elapsedMs = performance.now() - startMs;
  if (elapsedMs > config.maxRuntimeMs) {
    throw new Error(
      `Benchmark exceeded time budget (${config.maxRuntimeMs} ms) during ${stage}. Elapsed: ${elapsedMs.toFixed(1)} ms.`,
    );
  }
}

async function runTimedCase(
  config: BenchConfig,
  benchmarkStartMs: number,
  name: CaseName,
  operations: number,
  runBody: () => Promise<void>,
): Promise<CaseSummary> {
  const samples: number[] = [];

  for (let i = 0; i < config.warmupRuns; i++) {
    await runBody();
    enforceTimeBudget(benchmarkStartMs, config, `${name} warmup`);
  }

  for (let i = 0; i < config.runsPerCase; i++) {
    const t0 = performance.now();
    await runBody();
    const t1 = performance.now();
    samples.push(t1 - t0);
    enforceTimeBudget(benchmarkStartMs, config, `${name} measured run ${i + 1}/${config.runsPerCase}`);
  }

  const med = median(samples);
  const msPerOp = med / operations;
  const opsPerSecond = 1000 / msPerOp;

  console.log(`- ${name}: median=${fmtMs(med)} | ms/op=${msPerOp.toFixed(6)} | ops/s=${opsPerSecond.toFixed(2)}`);

  return {
    samplesMs: samples,
    medianMs: med,
    operations,
    msPerOp,
    opsPerSecond,
  };
}

async function benchmark(): Promise<BenchmarkReport> {
  const config: BenchConfig = hasFlag('--full') ? FULL_CONFIG : QUICK_CONFIG;
  const benchmarkStartMs = performance.now();

  console.log('Preparing benchmark dataset...');
  console.log(`Profile: ${config.profile} (time budget: ${config.maxRuntimeMs} ms)`);
  const collection = await setupCollection(config.documentCount);
  enforceTimeBudget(benchmarkStartMs, config, 'dataset setup');
  console.log(`Dataset ready (${config.documentCount} docs).`);

  const idRand = xorshift32(42);
  const rangeRand = xorshift32(4242);
  const queryRand = xorshift32(424242);

  const exactIdLookup = await runTimedCase(
    config,
    benchmarkStartMs,
    'exactIdLookup',
    config.idLookupsPerRun,
    async () => {
      for (let i = 0; i < config.idLookupsPerRun; i++) {
        const idx = idRand() % config.documentCount;
        const id = `doc_${idx.toString().padStart(8, '0')}`;
        const found = await collection.findById(id);
        if (found === null) {
          throw new Error(`Missing document for id ${id}`);
        }
      }
    },
  );

  const shortRangeScan = await runTimedCase(
    config,
    benchmarkStartMs,
    'shortRangeScan',
    config.rangeQueriesPerRun,
    async () => {
      for (let i = 0; i < config.rangeQueriesPerRun; i++) {
        const start = rangeRand() % (config.documentCount - config.rangeWidth - 1);
        const end = start + config.rangeWidth;

        const query: Query = {
          idRange: {
            min: `doc_${start.toString().padStart(8, '0')}`,
            max: `doc_${end.toString().padStart(8, '0')}`,
          },
        };

        const results = await collection.find(query);
        if (results.length === 0) {
          throw new Error('Short range query returned no results');
        }
      }
    },
  );

  const indexedFilterQuery = await runTimedCase(
    config,
    benchmarkStartMs,
    'indexedFilterQuery',
    config.indexedQueriesPerRun,
    async () => {
      for (let i = 0; i < config.indexedQueriesPerRun; i++) {
        const threshold = queryRand() % 900;
        const results = await collection.find({
          filterOps: {
            status: { $eq: 'active' },
            score: { $gte: threshold, $lt: threshold + 100 },
          },
          limit: 100,
        });

        if (results.length === 0) {
          throw new Error('Indexed filter query returned no results');
        }
      }
    },
  );

  const report: BenchmarkReport = {
    benchmark: 'search-optimization',
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    config: {
      profile: config.profile,
      maxRuntimeMs: config.maxRuntimeMs,
      documentCount: config.documentCount,
      runsPerCase: config.runsPerCase,
      warmupRuns: config.warmupRuns,
      idLookupsPerRun: config.idLookupsPerRun,
      rangeQueriesPerRun: config.rangeQueriesPerRun,
      indexedQueriesPerRun: config.indexedQueriesPerRun,
      rangeWidth: config.rangeWidth,
    },
    cases: {
      exactIdLookup,
      shortRangeScan,
      indexedFilterQuery,
    },
  };

  return report;
}

async function maybeSaveReport(report: BenchmarkReport): Promise<void> {
  const savePath = parseArgValue('--save');
  if (!savePath) return;

  await mkdir(dirname(savePath), { recursive: true });
  await writeFile(savePath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`Saved benchmark report to ${savePath}`);
}

async function maybeCompareAgainstBaseline(report: BenchmarkReport): Promise<void> {
  const comparePath = parseArgValue('--compare');
  if (!comparePath) return;

  const baselineRaw = await readFile(comparePath, 'utf-8');
  const baseline = JSON.parse(baselineRaw) as BenchmarkReport;

  console.log('\nComparison vs baseline (negative is faster):');
  const caseNames: CaseName[] = ['exactIdLookup', 'shortRangeScan', 'indexedFilterQuery'];
  for (const caseName of caseNames) {
    const before = baseline.cases[caseName].msPerOp;
    const after = report.cases[caseName].msPerOp;
    const deltaPct = ((after - before) / before) * 100;
    const deltaMs = after - before;
    console.log(
      `- ${caseName}: ${fmtPct(deltaPct)} (${deltaMs >= 0 ? '+' : ''}${deltaMs.toFixed(6)} ms/op) | baseline=${before.toFixed(
        6,
      )} | current=${after.toFixed(6)}`,
    );
  }
}

async function main(): Promise<void> {
  if (hasFlag('--help')) {
    console.log(
      'Usage: tsx src/benchmarks/search-optimization-bench.mts [--full] [--save <file>] [--compare <baseline-file>]',
    );
    return;
  }

  const report = await benchmark();

  console.log('\nSummary (median values):');
  console.log(`- exactIdLookup: ${report.cases.exactIdLookup.msPerOp.toFixed(6)} ms/op`);
  console.log(`- shortRangeScan: ${report.cases.shortRangeScan.msPerOp.toFixed(6)} ms/op`);
  console.log(`- indexedFilterQuery: ${report.cases.indexedFilterQuery.msPerOp.toFixed(6)} ms/op`);

  await maybeSaveReport(report);
  await maybeCompareAgainstBaseline(report);
}

await main();
