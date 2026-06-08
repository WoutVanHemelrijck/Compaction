import { performance } from 'node:perf_hooks';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CompressionService,
  type CompressionAlgorithm,
} from '../../packages/dbms/durability/compression/compression.mjs';

type Scenario = {
  name: string;
  payload: Buffer;
};

type ScenarioResult = {
  algorithm: CompressionAlgorithm;
  scenario: string;
  originalBytes: number;
  compressedBytes: number;
  ratio: number;
  compressMs: number;
  decompressMs: number;
  compressMBps: number;
  decompressMBps: number;
};

const ALGORITHMS: CompressionAlgorithm[] = ['zstd', 'gzip', 'brotli', 'deflate'];

function randomBytes(size: number, seed = 123456789): Buffer {
  const out = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mbps(bytes: number, ms: number): number {
  if (ms <= 0) return 0;
  const mb = bytes / (1024 * 1024);
  return mb / (ms / 1000);
}

async function maybeReadFile(paths: string[]): Promise<Buffer | null> {
  for (const p of paths) {
    try {
      return await readFile(p);
    } catch {
      // Try next candidate path.
    }
  }
  return null;
}

async function buildScenarios(): Promise<Scenario[]> {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const srcRoot = path.resolve(currentDir, '..');
  const workspaceRoot = path.resolve(srcRoot, '..');

  const dummyAccount = await maybeReadFile([
    path.join(workspaceRoot, 'data', 'dummy-accounts', 'dummy-account.json'),
    path.join(workspaceRoot, 'build', '..', 'data', 'dummy-accounts', 'dummy-account.json'),
  ]);

  const documentsHtml = await maybeReadFile([
    path.join(srcRoot, 'frontend', 'components', 'documents.html'),
    path.join(workspaceRoot, 'build', 'frontend', 'components', 'documents.html'),
  ]);

  const scenarios: Scenario[] = [];

  if (dummyAccount) {
    scenarios.push({
      name: 'dummy-account-json (real project data)',
      payload: dummyAccount,
    });

    scenarios.push({
      name: 'dummy-account-json x20 (bigger realistic JSON)',
      payload: Buffer.from(dummyAccount.toString('utf-8').repeat(20), 'utf-8'),
    });
  }

  if (documentsHtml) {
    scenarios.push({
      name: 'frontend-documents-html',
      payload: documentsHtml,
    });
  }

  const logLike = Array.from({ length: 30_000 }, (_, i) => {
    return `2026-03-10T12:${String(i % 60).padStart(2, '0')}:00Z INFO user=${i % 1200} action=fetch_documents status=200 latency_ms=${i % 250}`;
  }).join('\n');

  scenarios.push({
    name: 'log-lines-text',
    payload: Buffer.from(logLike, 'utf-8'),
  });

  const nestedJsonObject = {
    version: 1,
    generatedAt: new Date().toISOString(),
    users: Array.from({ length: 3000 }, (_, i) => ({
      id: `user-${i}`,
      roles: ['reader', i % 2 === 0 ? 'writer' : 'viewer'],
      profile: {
        email: `user-${i}@example.com`,
        tags: ['team-09', 'simpledbms', `group-${i % 20}`],
        active: i % 3 !== 0,
      },
      history: Array.from({ length: 8 }, (__, j) => ({
        seq: j,
        event: 'update_document',
        payload: { collection: `c-${i % 15}`, status: j % 2 === 0 ? 'ok' : 'retry' },
      })),
    })),
  };

  scenarios.push({
    name: 'nested-json-blob',
    payload: Buffer.from(JSON.stringify(nestedJsonObject), 'utf-8'),
  });

  scenarios.push({
    name: 'incompressible-random-bytes-1MB',
    payload: randomBytes(1024 * 1024),
  });

  return scenarios;
}

function runOne(
  algorithm: CompressionAlgorithm,
  payload: Buffer,
  iterations: number,
): {
  compressedBytes: number;
  compressMs: number;
  decompressMs: number;
} {
  const service = new CompressionService({ algorithm });
  const compressTimes: number[] = [];
  const decompressTimes: number[] = [];

  let compressedBytes = 0;

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const compressed = service.compress(payload);
    const t1 = performance.now();
    const decompressed = service.decompress(compressed);
    const t2 = performance.now();

    if (!decompressed.equals(payload)) {
      throw new Error(`Roundtrip mismatch for algorithm '${algorithm}'`);
    }

    compressTimes.push(t1 - t0);
    decompressTimes.push(t2 - t1);
    compressedBytes = compressed.compressedSize;
  }

  return {
    compressedBytes,
    compressMs: median(compressTimes),
    decompressMs: median(decompressTimes),
  };
}

function printScenarioResults(results: ScenarioResult[]) {
  const sorted = [...results].sort((a, b) => a.scenario.localeCompare(b.scenario) || a.ratio - b.ratio);

  let currentScenario = '';
  for (const r of sorted) {
    if (r.scenario !== currentScenario) {
      currentScenario = r.scenario;
      console.log(`\nScenario: ${r.scenario}`);
      console.log('algorithm\tratio\tcompressedKB\tcompressMBps\tdecompressMBps\tcompressMs\tdecompressMs');
    }

    console.log(
      `${r.algorithm}\t${r.ratio.toFixed(3)}\t${(r.compressedBytes / 1024).toFixed(1)}\t${r.compressMBps.toFixed(
        2,
      )}\t${r.decompressMBps.toFixed(2)}\t${r.compressMs.toFixed(3)}\t${r.decompressMs.toFixed(3)}`,
    );
  }
}

function printOverallSummary(results: ScenarioResult[]) {
  const byAlgorithm = new Map<CompressionAlgorithm, ScenarioResult[]>();
  for (const r of results) {
    const list = byAlgorithm.get(r.algorithm) ?? [];
    list.push(r);
    byAlgorithm.set(r.algorithm, list);
  }

  console.log('\nOverall summary (lower ratio is better, higher MB/s is better):');
  console.log('algorithm\tavgRatio\tavgCompressMBps\tavgDecompressMBps');

  for (const algorithm of ALGORITHMS) {
    const rows = byAlgorithm.get(algorithm) ?? [];
    if (rows.length === 0) continue;
    const avgRatio = rows.reduce((s, x) => s + x.ratio, 0) / rows.length;
    const avgCompress = rows.reduce((s, x) => s + x.compressMBps, 0) / rows.length;
    const avgDecompress = rows.reduce((s, x) => s + x.decompressMBps, 0) / rows.length;
    console.log(`${algorithm}\t${avgRatio.toFixed(3)}\t${avgCompress.toFixed(2)}\t${avgDecompress.toFixed(2)}`);
  }
}

function buildCsv(results: ScenarioResult[]): string {
  const lines: string[] = [];
  lines.push(
    [
      'type',
      'scenario',
      'algorithm',
      'original_bytes',
      'compressed_bytes',
      'ratio',
      'compress_ms',
      'decompress_ms',
      'compress_mbps',
      'decompress_mbps',
    ].join(','),
  );

  for (const r of results) {
    lines.push(
      [
        'scenario',
        JSON.stringify(r.scenario),
        r.algorithm,
        String(r.originalBytes),
        String(r.compressedBytes),
        r.ratio.toFixed(6),
        r.compressMs.toFixed(6),
        r.decompressMs.toFixed(6),
        r.compressMBps.toFixed(6),
        r.decompressMBps.toFixed(6),
      ].join(','),
    );
  }

  const byAlgorithm = new Map<CompressionAlgorithm, ScenarioResult[]>();
  for (const r of results) {
    const list = byAlgorithm.get(r.algorithm) ?? [];
    list.push(r);
    byAlgorithm.set(r.algorithm, list);
  }

  for (const algorithm of ALGORITHMS) {
    const rows = byAlgorithm.get(algorithm) ?? [];
    if (rows.length === 0) continue;
    const avgRatio = rows.reduce((s, x) => s + x.ratio, 0) / rows.length;
    const avgCompress = rows.reduce((s, x) => s + x.compressMBps, 0) / rows.length;
    const avgDecompress = rows.reduce((s, x) => s + x.decompressMBps, 0) / rows.length;

    lines.push(
      [
        'summary',
        '',
        algorithm,
        '',
        '',
        avgRatio.toFixed(6),
        '',
        '',
        avgCompress.toFixed(6),
        avgDecompress.toFixed(6),
      ].join(','),
    );
  }

  return lines.join('\n') + '\n';
}

function getCsvOutputPath(argv: string[]): string | null {
  const csvFlagIndex = argv.findIndex((arg) => arg === '--csv');
  if (csvFlagIndex === -1) {
    return null;
  }

  const outputPath = argv[csvFlagIndex + 1];
  if (!outputPath || outputPath.startsWith('--')) {
    throw new Error("When using '--csv', provide an output path. Example: --csv bench-results.csv");
  }

  return outputPath;
}

async function main() {
  const quick = process.argv.includes('--quick');
  const csvOutputPath = getCsvOutputPath(process.argv);
  const iterations = quick ? 5 : 15;

  console.log(`Compression benchmark (${quick ? 'quick' : 'full'}) - iterations per scenario: ${iterations}`);
  const scenarios = await buildScenarios();

  if (scenarios.length === 0) {
    throw new Error('No benchmark scenarios available.');
  }

  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    console.log(`Running scenario: ${scenario.name} (${(scenario.payload.length / 1024).toFixed(1)} KB)`);

    for (const algorithm of ALGORITHMS) {
      const measurement = runOne(algorithm, scenario.payload, iterations);
      results.push({
        algorithm,
        scenario: scenario.name,
        originalBytes: scenario.payload.length,
        compressedBytes: measurement.compressedBytes,
        ratio: measurement.compressedBytes / scenario.payload.length,
        compressMs: measurement.compressMs,
        decompressMs: measurement.decompressMs,
        compressMBps: mbps(scenario.payload.length, measurement.compressMs),
        decompressMBps: mbps(scenario.payload.length, measurement.decompressMs),
      });
    }
  }

  printScenarioResults(results);
  printOverallSummary(results);

  if (csvOutputPath) {
    const csv = buildCsv(results);
    await writeFile(csvOutputPath, csv, 'utf-8');
    console.log(`\nCSV written to: ${csvOutputPath}`);
  }
}

await main();
