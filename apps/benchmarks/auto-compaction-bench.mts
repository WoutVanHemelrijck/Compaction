// @author Wout Van Hemelrijck
// @date 2026-05-06
//
// Auto-compaction threshold benchmark.
//
// Sweeps fragmentation ratio (0–70 %) across three DB sizes and measures:
//   • shrinkDatabase() wall-clock time
//   • space reclaimed (bytes before → after)
//   • DB reopen time (close + SimpleDBMS.open)
//   • read throughput (findById ops/s) before and after shrink
//   • write throughput (insert ops/s) before and after shrink
//   • efficiency: KB reclaimed per ms of total compaction time
//
// From these measurements the script derives concrete recommended values for
// AutoCompactionConfig and prints them with full reasoning.
//
// Usage:
//   npx tsx src/benchmarks/auto-compaction-bench.mts
//   npx tsx src/benchmarks/auto-compaction-bench.mts --quick
//   npx tsx src/benchmarks/auto-compaction-bench.mts --csv results.csv
//   npx tsx src/benchmarks/auto-compaction-bench.mts --realfs   (real disk I/O; slower)

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SimpleDBMS, type Document } from '../../packages/dbms/core/simpledbms.mjs';
import { MockFile } from '../../packages/dbms/storage/file/mockfile.mjs';
import { RealFile } from '../../packages/dbms/storage/file/file.mjs';
import { shrinkDatabase } from '../../packages/dbms/durability/compaction/compaction.mjs';
import { FreeBlockFile, NO_BLOCK } from '../../packages/dbms/storage/freeblockfile.mjs';

// ── Configuration ─────────────────────────────────────────────────────────────

const FREE_RATIOS_FULL = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7];
const FREE_RATIOS_QUICK = [0.1, 0.2, 0.3, 0.5, 0.7];

const DB_SIZES_FULL = [
  { label: 'small', totalDocs: 80 },
  { label: 'medium', totalDocs: 250 },
  { label: 'large', totalDocs: 600 },
];
const DB_SIZES_QUICK = [
  { label: 'small', totalDocs: 60 },
  { label: 'medium', totalDocs: 180 },
];

/** Number of ops used for throughput sampling. */
const THROUGHPUT_OPS = 25;

// ── Types ─────────────────────────────────────────────────────────────────────

interface DataPoint {
  dbLabel: string;
  totalDocs: number;
  freeRatio: number;
  /** Actual total FBF blocks measured after build. */
  totalBlocks: number;
  /** Actual free FBF blocks measured after build. */
  freeBlocks: number;
  sizeBefore: number; // bytes
  sizeAfter: number; // bytes
  spaceSavedKB: number;
  spaceSavedPct: number;
  blocksRelocated: number;
  shrinkMs: number;
  reopenMs: number;
  totalCompactMs: number;
  /** KB saved per ms of total compaction time (higher = more efficient). */
  efficiencyKBperMs: number;
  readOpsBefore: number; // ops/s
  readOpsAfter: number; // ops/s
  writeOpsBefore: number; // ops/s
  writeOpsAfter: number; // ops/s
}

// ── Document factory ──────────────────────────────────────────────────────────

function makeDoc(i: number): Document {
  return {
    id: `item-${i}`,
    title: `Document ${i}`,
    body: `Body text for item ${i}. `.repeat(6), // ~140 chars
    tags: [`tag-${i % 8}`, `cat-${i % 4}`],
    value: i * 1.5,
    createdAt: new Date(Date.now() - i * 60_000).toISOString(),
  };
}

// ── XOR-shift shuffle ─────────────────────────────────────────────────────────

function shuffledIndices(n: number, seed = 42): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  let s = seed >>> 0;
  const next = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
  for (let i = n - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── FBF helpers ───────────────────────────────────────────────────────────────

async function countFreeBlocks(fbf: FreeBlockFile, totalBlocks: number): Promise<number> {
  let count = 0;
  let head = await fbf.debug_getFreeListHead();
  while (head !== NO_BLOCK && head < totalBlocks) {
    count++;
    const block = await fbf.readRawBlock(head);
    head = block.readUInt32LE(0);
  }
  return count;
}

// ── File factory (mock vs real) ───────────────────────────────────────────────

type AnyFile = MockFile | RealFile;

interface FileSet {
  dbFile: AnyFile;
  walFile: AnyFile;
  cleanup: () => Promise<void>;
}

async function makeFiles(useMock: boolean): Promise<FileSet> {
  if (useMock) {
    return {
      dbFile: new MockFile(512),
      walFile: new MockFile(512),
      cleanup: async () => {
        /* nothing */
      },
    };
  }
  const dir = await mkdtemp(join(tmpdir(), 'ac-bench-'));
  return {
    dbFile: new RealFile(join(dir, 'bench.db')),
    walFile: new RealFile(join(dir, 'bench.wal')),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

// ── Throughput helpers ────────────────────────────────────────────────────────

function hrMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

async function measureReadOps(db: SimpleDBMS, ids: string[], ops: number): Promise<number> {
  const col = await db.getCollection('items');
  const t0 = hrMs();
  for (let i = 0; i < ops; i++) await col.findById(ids[i % ids.length]);
  const elapsed = hrMs() - t0;
  return (ops / elapsed) * 1000;
}

async function measureWriteOps(db: SimpleDBMS, ops: number, startId: number): Promise<number> {
  const col = await db.getCollection('items');
  const t0 = hrMs();
  for (let i = 0; i < ops; i++) {
    const doc = await col.insert(makeDoc(startId + i));
    await col.delete(doc['id']);
  }
  const elapsed = hrMs() - t0;
  return (ops / elapsed) * 1000;
}

// ── Core measurement ──────────────────────────────────────────────────────────

async function runDataPoint(
  size: { label: string; totalDocs: number },
  freeRatio: number,
  useMock: boolean,
): Promise<DataPoint> {
  const deleteCount = Math.floor(size.totalDocs * freeRatio);
  const deleteOrder = shuffledIndices(size.totalDocs).slice(0, deleteCount);

  const files = await makeFiles(useMock);
  try {
    // ── Build fragmented database ──────────────────────────────────────────
    let db = await SimpleDBMS.create(files.dbFile, files.walFile);
    const col = await db.createCollection('items');
    for (let i = 0; i < size.totalDocs; i++) await col.insert(makeDoc(i));
    await db.commit();

    for (const idx of deleteOrder) {
      try {
        await col.delete(`item-${idx}`);
      } catch {
        /* skip */
      }
    }
    await db.commit();

    // ── Surviving IDs for read sampling ───────────────────────────────────
    const deletedSet = new Set(deleteOrder);
    const survivingIds = Array.from({ length: size.totalDocs }, (_, i) => i)
      .filter((i) => !deletedSet.has(i))
      .map((i) => `item-${i}`)
      .slice(0, 30);

    // ── Pre-shrink state ──────────────────────────────────────────────────
    const fbf = db.getFreeBlockFile();
    const totalBlocks = await fbf.getTotalBlockCount();
    const freeBlocks = await countFreeBlocks(fbf, totalBlocks);

    const readOpsBefore = survivingIds.length > 0 ? await measureReadOps(db, survivingIds, THROUGHPUT_OPS) : 0;
    const writeOpsBefore = await measureWriteOps(db, THROUGHPUT_OPS, size.totalDocs + 100_000);
    await db.commit(); // flush dirty WAL before shrink to avoid corruption

    // ── Shrink ────────────────────────────────────────────────────────────
    const t0Shrink = hrMs();
    const shrinkResult = await shrinkDatabase(fbf);
    const shrinkMs = hrMs() - t0Shrink;

    // ── Reopen ────────────────────────────────────────────────────────────
    const t0Reopen = hrMs();
    await db.close();
    db = await SimpleDBMS.open(files.dbFile, files.walFile);
    const reopenMs = hrMs() - t0Reopen;

    // ── Post-shrink throughput ────────────────────────────────────────────
    const readOpsAfter = survivingIds.length > 0 ? await measureReadOps(db, survivingIds, THROUGHPUT_OPS) : 0;
    const writeOpsAfter = await measureWriteOps(db, THROUGHPUT_OPS, size.totalDocs + 200_000);
    await db.commit(); // flush post-shrink writes before close

    await db.close();

    const spaceSavedKB = (shrinkResult.sizeBefore - shrinkResult.sizeAfter) / 1024;
    const spaceSavedPct =
      shrinkResult.sizeBefore > 0
        ? ((shrinkResult.sizeBefore - shrinkResult.sizeAfter) / shrinkResult.sizeBefore) * 100
        : 0;
    const totalCompactMs = shrinkMs + reopenMs;

    return {
      dbLabel: size.label,
      totalDocs: size.totalDocs,
      freeRatio,
      totalBlocks,
      freeBlocks,
      sizeBefore: shrinkResult.sizeBefore,
      sizeAfter: shrinkResult.sizeAfter,
      spaceSavedKB,
      spaceSavedPct,
      blocksRelocated: shrinkResult.blocksRelocated,
      shrinkMs,
      reopenMs,
      totalCompactMs,
      efficiencyKBperMs: totalCompactMs > 0 ? spaceSavedKB / totalCompactMs : 0,
      readOpsBefore,
      readOpsAfter,
      writeOpsBefore,
      writeOpsAfter,
    };
  } finally {
    await files.cleanup();
  }
}

// ── ASCII bar chart ───────────────────────────────────────────────────────────

/**
 * Prints a grouped horizontal bar chart.
 *
 *   title
 *   ratio  ▏ small              ▏ medium             ▏ large
 *    5%    ▏ ███  12.3 u        ▏ █████  22.1 u      ▏ ████████  45.0 u
 *   10%    ▏ ████  18.7 u       ▏ █████████  41.2 u  ▏ ...
 */
function barChart(
  title: string,
  unit: string,
  ratios: number[],
  series: Array<{ label: string; values: number[] }>,
  barWidth = 22,
): void {
  const maxVal = Math.max(...series.flatMap((s) => s.values), 0.001);

  const hdr = series.map((s) => s.label.padEnd(barWidth + 12)).join('');
  console.log(`\n  ${title}`);
  console.log(`  ${'ratio'.padEnd(7)} ${hdr}`);
  console.log(`  ${'─'.repeat(7 + series.length * (barWidth + 13))}`);

  for (let ri = 0; ri < ratios.length; ri++) {
    const label = `${(ratios[ri] * 100).toFixed(0).padStart(3)}%   `;
    const cols = series.map((s) => {
      const v = s.values[ri] ?? 0;
      const len = Math.round((v / maxVal) * barWidth);
      const bar = '█'.repeat(Math.max(0, len));
      const num = v < 10 ? v.toFixed(2) : v.toFixed(1);
      return `▏ ${bar.padEnd(barWidth)} ${num} ${unit}`;
    });
    console.log(`  ${label}${cols.join('  ')}`);
  }
}

// ── Raw data table ────────────────────────────────────────────────────────────

function printTable(points: DataPoint[]): void {
  const cols = [
    'dbSize',
    'docs',
    'freeRatio%',
    'totalBlocks',
    'freeBlocks',
    'sizeBefore_KB',
    'sizeAfter_KB',
    'savedKB',
    'saved%',
    'shrinkMs',
    'reopenMs',
    'totalMs',
    'efficiency_KB/ms',
    'readBefore',
    'readAfter',
    'writeBefore',
    'writeAfter',
  ];
  console.log('\n  ' + cols.join('\t'));
  for (const p of points) {
    console.log(
      [
        p.dbLabel,
        p.totalDocs,
        (p.freeRatio * 100).toFixed(0),
        p.totalBlocks,
        p.freeBlocks,
        (p.sizeBefore / 1024).toFixed(1),
        (p.sizeAfter / 1024).toFixed(1),
        p.spaceSavedKB.toFixed(1),
        p.spaceSavedPct.toFixed(1),
        p.shrinkMs.toFixed(1),
        p.reopenMs.toFixed(1),
        p.totalCompactMs.toFixed(1),
        p.efficiencyKBperMs.toFixed(3),
        p.readOpsBefore.toFixed(0),
        p.readOpsAfter.toFixed(0),
        p.writeOpsBefore.toFixed(0),
        p.writeOpsAfter.toFixed(0),
      ].join('\t'),
    );
  }
}

// ── CSV builder ───────────────────────────────────────────────────────────────

function buildCsv(points: DataPoint[]): string {
  const header = [
    'db_label',
    'total_docs',
    'free_ratio',
    'total_blocks',
    'free_blocks',
    'size_before_bytes',
    'size_after_bytes',
    'space_saved_kb',
    'space_saved_pct',
    'blocks_relocated',
    'shrink_ms',
    'reopen_ms',
    'total_compact_ms',
    'efficiency_kb_per_ms',
    'read_ops_before',
    'read_ops_after',
    'write_ops_before',
    'write_ops_after',
  ].join(',');

  const rows = points.map((p) =>
    [
      p.dbLabel,
      p.totalDocs,
      p.freeRatio.toFixed(2),
      p.totalBlocks,
      p.freeBlocks,
      p.sizeBefore,
      p.sizeAfter,
      p.spaceSavedKB.toFixed(3),
      p.spaceSavedPct.toFixed(3),
      p.blocksRelocated,
      p.shrinkMs.toFixed(3),
      p.reopenMs.toFixed(3),
      p.totalCompactMs.toFixed(3),
      p.efficiencyKBperMs.toFixed(6),
      p.readOpsBefore.toFixed(1),
      p.readOpsAfter.toFixed(1),
      p.writeOpsBefore.toFixed(1),
      p.writeOpsAfter.toFixed(1),
    ].join(','),
  );

  return [header, ...rows].join('\n') + '\n';
}

// ── Recommendation engine ─────────────────────────────────────────────────────

function deriveRecommendations(points: DataPoint[], useMock: boolean): void {
  // Aggregate per ratio across all DB sizes
  const ratios = [...new Set(points.map((p) => p.freeRatio))].sort((a, b) => a - b);

  interface RatioStat {
    ratio: number;
    avgEfficiency: number;
    avgShrinkMs: number;
    avgReopenMs: number;
    avgTotalMs: number;
    avgSavedKB: number;
    avgSavedPct: number;
  }

  const ratioStats: RatioStat[] = ratios.map((ratio) => {
    const pts = points.filter((p) => p.freeRatio === ratio);
    const avg = (fn: (p: DataPoint) => number) => pts.reduce((s, p) => s + fn(p), 0) / pts.length;
    return {
      ratio,
      avgEfficiency: avg((p) => p.efficiencyKBperMs),
      avgShrinkMs: avg((p) => p.shrinkMs),
      avgReopenMs: avg((p) => p.reopenMs),
      avgTotalMs: avg((p) => p.totalCompactMs),
      avgSavedKB: avg((p) => p.spaceSavedKB),
      avgSavedPct: avg((p) => p.spaceSavedPct),
    };
  });

  // ── Threshold: ratio at which efficiency first peaks ──────────────────
  let peakStat = ratioStats[0];
  for (const s of ratioStats) {
    if (s.avgEfficiency > peakStat.avgEfficiency) peakStat = s;
  }

  // Round threshold to the nearest 5 % (standard config granularity)
  const rawThreshold = peakStat.ratio;
  const roundedThreshold = Math.round(rawThreshold / 0.05) * 0.05;

  // ── minFreeBytes: 2× the absolute saving of the smallest scenario at threshold ─
  const smallPtsAtThreshold = points.filter((p) => p.dbLabel === 'small' && p.freeRatio === rawThreshold);
  const smallSavedBytes = smallPtsAtThreshold.length > 0 ? smallPtsAtThreshold[0].spaceSavedKB * 1024 : 512 * 1024;
  const suggestedMinFreeBytes = Math.max(512 * 1024, Math.round((smallSavedBytes * 2) / (64 * 1024)) * (64 * 1024));

  // ── minIntervalMs: 10× worst-case total compaction time (+ round to 5 s) ─
  const worstTotalMs = Math.max(...points.map((p) => p.totalCompactMs));
  const suggestedIntervalMs = Math.max(30_000, Math.ceil((worstTotalMs * 10) / 5_000) * 5_000);

  // ── checkDebounceMs: empirically reasonable; not benchmarkable here ───
  const suggestedDebounceMs = 5_000;

  // ── Print ──────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  console.log('  EFFICIENCY (KB saved / ms compaction time) BY FRAGMENTATION RATIO');
  console.log('  (averaged across all DB sizes)');
  console.log('═'.repeat(72));

  const maxEff = Math.max(...ratioStats.map((s) => s.avgEfficiency), 0.001);
  for (const s of ratioStats) {
    const len = Math.round((s.avgEfficiency / maxEff) * 36);
    const bar = '█'.repeat(len);
    const mark = s.ratio === rawThreshold ? '  ◄ peak' : '';
    const pct = `${(s.ratio * 100).toFixed(0).padStart(3)}%`;
    const eff = s.avgEfficiency.toFixed(3).padStart(6);
    const savedKB = s.avgSavedKB.toFixed(1).padStart(7);
    const msStr = s.avgTotalMs.toFixed(1).padStart(7);
    console.log(`  ${pct}  ${eff} KB/ms  avg saved ${savedKB} KB in ${msStr} ms  ${bar}${mark}`);
  }

  console.log('\n' + '═'.repeat(72));
  console.log('  RECOMMENDED AutoCompactionConfig');
  console.log('═'.repeat(72));
  console.log();
  console.log(`  fragmentationThreshold: ${roundedThreshold.toFixed(2)}`);
  console.log(
    `  minFreeBytes:           ${suggestedMinFreeBytes}     // ${(suggestedMinFreeBytes / 1024).toFixed(0)} KB`,
  );
  console.log(`  minIntervalMs:          ${suggestedIntervalMs}   // ${(suggestedIntervalMs / 1000).toFixed(0)} s`);
  console.log(`  checkDebounceMs:        ${suggestedDebounceMs}     // 5 s (not measured; conservative default)`);
  console.log();
  console.log('  Reasoning:');
  console.log(`    fragmentationThreshold = ${roundedThreshold.toFixed(2)}`);
  console.log(`      Peak efficiency (${peakStat.avgEfficiency.toFixed(3)} KB/ms) was observed at`);
  console.log(
    `      ${(rawThreshold * 100).toFixed(0)} % fragmentation, rounded to ${(roundedThreshold * 100).toFixed(0)} %.`,
  );
  console.log(`      Below this ratio the space saved per ms of compaction downtime`);
  console.log(`      is low enough that running shrink is not worth the disruption.`);
  console.log();
  console.log(`    minFreeBytes = ${suggestedMinFreeBytes} (${(suggestedMinFreeBytes / 1024).toFixed(0)} KB)`);
  console.log(`      The smallest-DB scenario at the threshold frees ~${(smallSavedBytes / 1024).toFixed(0)} KB.`);
  console.log(`      2× that value guards against running shrink when the absolute`);
  console.log(`      savings are negligible (e.g. a nearly-empty database).`);
  console.log();
  console.log(`    minIntervalMs = ${suggestedIntervalMs} (${(suggestedIntervalMs / 1000).toFixed(0)} s)`);
  console.log(`      Worst-case total compaction time observed: ${worstTotalMs.toFixed(0)} ms.`);
  console.log(`      10× that gives the DB time to accumulate meaningful new`);
  console.log(`      fragmentation before the next auto-shrink is allowed.`);
  console.log(
    `      ${
      useMock
        ? '(Measured on in-memory MockFile — real-disk runs will be slower;\n' +
          '       re-run with --realfs for disk-accurate minIntervalMs.)'
        : '(Measured on real disk.)'
    }`,
  );
  console.log();
  console.log('    checkDebounceMs = 5000');
  console.log('      This is a write-burst guard, not a function of shrink cost.');
  console.log('      5 s prevents re-checking after every individual insert during');
  console.log('      a bulk-load; adjust down if your workload does bursty writes');
  console.log('      shorter than 5 s apart.');
  console.log('═'.repeat(72));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const quick = args.includes('--quick');
  const useMock = !args.includes('--realfs');
  const csvFlag = args.indexOf('--csv');
  const csvPath = csvFlag !== -1 ? args[csvFlag + 1] : null;

  const ratios = quick ? FREE_RATIOS_QUICK : FREE_RATIOS_FULL;
  const sizes = quick ? DB_SIZES_QUICK : DB_SIZES_FULL;

  const total = ratios.length * sizes.length;

  console.log('═'.repeat(72));
  console.log('  Auto-Compaction Threshold Benchmark');
  console.log('═'.repeat(72));
  console.log(`  Mode:       ${quick ? 'quick' : 'full'}`);
  console.log(`  Backend:    ${useMock ? 'MockFile (in-memory)' : 'RealFile (disk)'}`);
  console.log(`  Data points: ${total}  (${sizes.length} DB sizes × ${ratios.length} fragmentation ratios)`);
  console.log(`  Throughput samples: ${THROUGHPUT_OPS} ops per measurement`);
  console.log('═'.repeat(72) + '\n');

  const results: DataPoint[] = [];
  let done = 0;

  for (const size of sizes) {
    for (const ratio of ratios) {
      process.stdout.write(
        `  [${String(++done).padStart(2)}/${total}] ${size.label.padEnd(6)}  freeRatio=${(ratio * 100).toFixed(0).padStart(3)}%  … `,
      );
      const t0 = hrMs();
      const pt = await runDataPoint(size, ratio, useMock);
      const elapsed = (hrMs() - t0).toFixed(0);
      process.stdout.write(
        `shrink=${pt.shrinkMs.toFixed(0)}ms  saved=${pt.spaceSavedKB.toFixed(0)}KB  (${elapsed}ms total)\n`,
      );
      results.push(pt);
    }
  }

  // ── Raw table ───────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  console.log('  RAW DATA TABLE');
  console.log('═'.repeat(72));
  printTable(results);

  // ── Charts ──────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  console.log('  CHARTS');
  console.log('═'.repeat(72));

  // Chart 1: Shrink time
  barChart(
    'Shrink time (ms) vs fragmentation ratio',
    'ms',
    ratios,
    sizes.map((s) => ({
      label: s.label,
      values: ratios.map((r) => results.find((p) => p.dbLabel === s.label && p.freeRatio === r)?.shrinkMs ?? 0),
    })),
  );

  // Chart 2: Space saved
  barChart(
    'Space saved (KB) vs fragmentation ratio',
    'KB',
    ratios,
    sizes.map((s) => ({
      label: s.label,
      values: ratios.map((r) => results.find((p) => p.dbLabel === s.label && p.freeRatio === r)?.spaceSavedKB ?? 0),
    })),
  );

  // Chart 3: Efficiency (KB/ms)
  barChart(
    'Efficiency (KB saved / ms compaction) vs fragmentation ratio',
    'KB/ms',
    ratios,
    sizes.map((s) => ({
      label: s.label,
      values: ratios.map(
        (r) => results.find((p) => p.dbLabel === s.label && p.freeRatio === r)?.efficiencyKBperMs ?? 0,
      ),
    })),
  );

  // Chart 4: Read throughput before vs after (medium DB only — clearest signal)
  const medLabel = sizes[Math.min(1, sizes.length - 1)].label;
  const medPts = results.filter((p) => p.dbLabel === medLabel);
  if (medPts.length > 0) {
    barChart(`Read throughput (ops/s) before vs after shrink — ${medLabel} DB`, 'ops/s', ratios, [
      { label: 'before', values: medPts.map((p) => p.readOpsBefore) },
      { label: 'after', values: medPts.map((p) => p.readOpsAfter) },
    ]);
    barChart(`Write throughput (ops/s) before vs after shrink — ${medLabel} DB`, 'ops/s', ratios, [
      { label: 'before', values: medPts.map((p) => p.writeOpsBefore) },
      { label: 'after', values: medPts.map((p) => p.writeOpsAfter) },
    ]);
  }

  // Chart 5: Reopen time
  barChart(
    'Reopen time (ms) vs fragmentation ratio',
    'ms',
    ratios,
    sizes.map((s) => ({
      label: s.label,
      values: ratios.map((r) => results.find((p) => p.dbLabel === s.label && p.freeRatio === r)?.reopenMs ?? 0),
    })),
  );

  // ── Recommendation ──────────────────────────────────────────────────────
  deriveRecommendations(results, useMock);

  // ── CSV ─────────────────────────────────────────────────────────────────
  if (csvPath) {
    const csv = buildCsv(results);
    await writeFile(csvPath, csv, 'utf-8');
    console.log(`\n  CSV written to: ${csvPath}`);
  }
}

await main();
