// @author: Frederick Hillen
// @date: 2026-05-02

/**
 * Disk-backed storage for parallel index entries with fail-safe memory management.
 * Implements circuit breaker pattern to prevent OOM and automatic fallback to safer algorithms.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as v8 from 'node:v8';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

export interface IndexEntry {
  key: string;
  value: number;
  directBlockId?: number;
}

function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

/**
 * Circuit breaker for memory management.
 * Tracks memory violations and triggers fallback strategies.
 */
class MemoryCircuitBreaker {
  private violationCount = 0;
  private lastViolationTime = 0;
  private readonly hardLimitPercent: number;
  private readonly softLimitPercent: number;
  private readonly maxViolationsBeforeFallback = 3;
  private readonly violationResetTimeMs = 5000;

  constructor(hardLimitPercent = 85, softLimitPercent = 70) {
    this.hardLimitPercent = hardLimitPercent;
    this.softLimitPercent = softLimitPercent;
  }

  getMemoryStatus(): {
    percent: number;
    isSoftLimitExceeded: boolean;
    isHardLimitExceeded: boolean;
    isCircuitOpen: boolean;
  } {
    const heapStats = v8.getHeapStatistics();
    const percent = Math.round((heapStats.total_heap_size / heapStats.heap_size_limit) * 100);
    const isSoftLimitExceeded = percent > this.softLimitPercent;
    const isHardLimitExceeded = percent > this.hardLimitPercent;
    const isCircuitOpen = this.violationCount >= this.maxViolationsBeforeFallback;

    // Reset violations after time window
    const now = Date.now();
    if (now - this.lastViolationTime > this.violationResetTimeMs) {
      this.violationCount = 0;
    }

    if (isSoftLimitExceeded) {
      this.violationCount++;
      this.lastViolationTime = now;
    }

    return {
      percent,
      isSoftLimitExceeded,
      isHardLimitExceeded,
      isCircuitOpen,
    };
  }

  reset(): void {
    this.violationCount = 0;
    this.lastViolationTime = 0;
  }
}

/**
 * Disk-backed storage with fail-safe memory management and automatic fallbacks.
 */
export class DiskBackedIndexStorage {
  private entries: IndexEntry[] = [];
  private tempDir: string;
  private namespace: string;
  private chunkFiles: string[] = [];
  private chunkIndex: number = 0;
  private circuitBreaker: MemoryCircuitBreaker;

  // Configurable limits
  private readonly BATCH_SIZE_FOR_DISK = 250000;
  private readonly MAX_CONCURRENT_CHUNKS = 8;

  constructor(namespace = randomUUID(), hardLimitPercent = 85, softLimitPercent = 70) {
    this.tempDir = path.resolve(os.tmpdir());
    this.namespace = namespace;
    this.circuitBreaker = new MemoryCircuitBreaker(hardLimitPercent, softLimitPercent);
  }

  /**
   * Recover a DiskBackedIndexStorage from existing chunk files on disk.
   * Used when resuming an interrupted import.
   * @param {string[]} existingChunkFiles - List of chunk file paths
   * @returns {DiskBackedIndexStorage} Recovered storage instance
   */
  static fromExistingChunks(existingChunkFiles: string[]): DiskBackedIndexStorage {
    const instance = new DiskBackedIndexStorage();
    instance.chunkFiles = [...existingChunkFiles];
    instance.chunkIndex = existingChunkFiles.length;
    return instance;
  }

  /**
   * Parse a JSON line into an IndexEntry safely.
   * Throws if the line is not a valid entry object.
   */
  private parseEntryLine(line: string): IndexEntry {
    const parsed = JSON.parse(line) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Invalid chunk entry: expected object');
    }

    const obj = parsed as Record<string, unknown>;
    const rawKey = obj['key'];
    const rawValue = obj['value'];
    const rawDirectBlockId = obj['directBlockId'];

    if (typeof rawKey !== 'string') {
      throw new Error('Invalid chunk entry: key must be a string');
    }

    if (typeof rawValue !== 'number' || Number.isNaN(rawValue)) {
      throw new Error('Invalid chunk entry: value must be a number');
    }

    if (rawDirectBlockId !== undefined && (typeof rawDirectBlockId !== 'number' || Number.isNaN(rawDirectBlockId))) {
      throw new Error('Invalid chunk entry: directBlockId must be a number when present');
    }

    return {
      key: rawKey,
      value: rawValue,
      directBlockId: typeof rawDirectBlockId === 'number' ? rawDirectBlockId : undefined,
    };
  }

  /**
   * Check if memory usage requires flushing to disk.
   * Uses circuit breaker to prevent OOM and enforce hard limits.
   */
  private shouldFlushToDisk(): boolean {
    const status = this.circuitBreaker.getMemoryStatus();

    // Soft flush: proactive flushing at soft limit
    if (status.isSoftLimitExceeded) {
      return true;
    }

    // Always flush before hitting hard limit
    if (status.isHardLimitExceeded) {
      console.warn(`HARD memory limit (${status.percent}%) exceeded! Forcing immediate flush.`);
      return true;
    }

    return false;
  }

  /**
   * Add entries to storage, flushing to disk if necessary.
   * @param {IndexEntry[]} newEntries Entries to add
   */
  async add(newEntries: IndexEntry[]): Promise<void> {
    this.entries.push(...newEntries);

    // Flush either when the batch gets large or when heap usage gets tight.
    if (this.entries.length >= this.BATCH_SIZE_FOR_DISK || this.shouldFlushToDisk()) {
      await this.flushToDisk();
    }
  }

  /**
   * Flush accumulated entries to a disk file and clear memory.
   */
  private async flushToDisk(): Promise<void> {
    if (this.entries.length === 0) return;

    // Sort entries before writing
    this.entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const chunkPath = path.join(this.tempDir, `index-chunk-${this.namespace}-${this.chunkIndex++}.jsonl`);
    const payload = this.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    await fs.writeFile(chunkPath, payload, 'utf8');
    this.chunkFiles.push(chunkPath);

    console.log(`Flushed ${this.entries.length} entries to disk: ${chunkPath}`);
    this.entries = [];
  }

  /**
   * Get all entries sorted, either from memory or by merging disk chunks.
   * @returns {Promise<IndexEntry[]>} All entries sorted
   */
  async getSorted(): Promise<IndexEntry[]> {
    const result: IndexEntry[] = [];
    for await (const entry of this.iterateSortedEntries()) {
      result.push(entry);
    }
    return result;
  }

  async *iterateSortedEntries(): AsyncGenerator<IndexEntry, void, unknown> {
    const mergeStartedAt = process.hrtime.bigint();

    if (this.entries.length > 0) {
      await this.flushToDisk();
    }

    if (this.chunkFiles.length === 0) {
      return;
    }

    console.log(`Starting merge of ${this.chunkFiles.length} chunk files...`);

    if (this.chunkFiles.length === 1) {
      const singleFileStartedAt = process.hrtime.bigint();
      yield* this.iterateChunkFile(this.chunkFiles[0]);
      console.log(`Single-file merge finished in ${elapsedMs(singleFileStartedAt).toFixed(0)} ms`);
      return;
    }

    try {
      let entryCount = 0;
      let lastMemoryWarning = '';

      for await (const entry of this.iterateMergedChunks()) {
        yield entry;
        entryCount++;

        if (entryCount % 100000 === 0) {
          const status = this.circuitBreaker.getMemoryStatus();
          const statusStr = `heap: ${status.percent}%`;
          const warningStr = status.isHardLimitExceeded
            ? 'HARD LIMIT!'
            : status.isSoftLimitExceeded
              ? 'soft limit'
              : '';

          console.log(`  Merged ${entryCount} entries (${statusStr}${warningStr})`);
          lastMemoryWarning = warningStr;
        }
      }

      console.log(`Merge complete: ${entryCount} total entries${lastMemoryWarning ? ' (warnings during merge)' : ''}`);
      console.log(`Total merge time: ${elapsedMs(mergeStartedAt).toFixed(0)} ms`);
    } finally {
      // Cleanup any remaining files
      await this.cleanup();
      this.circuitBreaker.reset();
    }
  }

  private async *iterateChunkFile(filePath: string): AsyncGenerator<IndexEntry, void, unknown> {
    const reader = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    try {
      for await (const line of reader) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }

        yield this.parseEntryLine(trimmed);
      }
    } finally {
      reader.close();
    }
  }

  /**
   * Merge-sort multiple chunk files without loading all into memory.
   * Implements circuit breaker: if memory pressure detected, automatically falls back to safer strategies.
   * Yields entries in sorted order.
   */
  private async *iterateMergedChunks(): AsyncGenerator<IndexEntry, void, unknown> {
    const status = this.circuitBreaker.getMemoryStatus();

    // Choose merge strategy based on memory pressure
    if (status.isCircuitOpen || status.isSoftLimitExceeded) {
      // Fall back to ultra-safe single-stream sequential merge
      console.log(
        `Memory pressure detected (${status.percent}%). Falling back to single-stream merge (slower but safer).`,
      );
      yield* this.singleStreamSequentialMerge();
    } else if (this.chunkFiles.length <= this.MAX_CONCURRENT_CHUNKS) {
      // Standard bounded k-way merge
      yield* this.mergeChunkFiles(this.chunkFiles);
    } else {
      // Multi-pass merge with bounded intermediate files
      yield* this.boundedMultiPassMerge(this.chunkFiles, this.MAX_CONCURRENT_CHUNKS);
    }
  }

  /**
   * Ultra-safe single-stream sequential merge.
   * Processes one chunk file at a time to guarantee constant memory usage.
   * Slower but bulletproof against OOM.
   */
  private async *singleStreamSequentialMerge(): AsyncGenerator<IndexEntry, void, unknown> {
    if (this.chunkFiles.length === 0) return;

    console.log(`Single-stream merge: processing ${this.chunkFiles.length} files sequentially...`);

    let currentFiles = [...this.chunkFiles];
    let passNumber = 0;

    while (currentFiles.length > 1) {
      const passStartedAt = process.hrtime.bigint();
      passNumber++;
      const nextPassFiles: string[] = [];

      for (let i = 0; i < currentFiles.length; i += 2) {
        const left = currentFiles[i];
        const right = i + 1 < currentFiles.length ? currentFiles[i + 1] : undefined;

        if (right === undefined) {
          nextPassFiles.push(left);
          continue;
        }

        const mergedFile = path.join(
          this.tempDir,
          `index-seq-${this.namespace}-p${passNumber}-g${Math.floor(i / 2)}.jsonl`,
        );
        const pairStartedAt = process.hrtime.bigint();
        await this.writeEntriesToChunkFile(mergedFile, this.mergeChunkFiles([left, right]));
        console.log(
          `Sequential pair ${passNumber}.${Math.floor(i / 2)}: ${path.basename(left)} + ${path.basename(right)} -> ${path.basename(mergedFile)} in ${elapsedMs(pairStartedAt).toFixed(0)} ms`,
        );
        nextPassFiles.push(mergedFile);

        await fs.rm(left, { force: true });
        await fs.rm(right, { force: true });
      }

      const status = this.circuitBreaker.getMemoryStatus();
      console.log(
        `    Sequential pass ${passNumber}: ${currentFiles.length} -> ${nextPassFiles.length} files (heap: ${status.percent}%)`,
      );
      console.log(`Sequential pass ${passNumber} time: ${elapsedMs(passStartedAt).toFixed(0)} ms`);

      currentFiles = nextPassFiles;
    }

    if (currentFiles.length === 1) {
      try {
        yield* this.iterateChunkFile(currentFiles[0]);
      } finally {
        await fs.rm(currentFiles[0], { force: true });
      }
    }
  }

  private async writeEntriesToChunkFile(filePath: string, entries: AsyncIterable<IndexEntry>): Promise<void> {
    const out = createWriteStream(filePath, { encoding: 'utf8' });
    const writeStartedAt = process.hrtime.bigint();
    const WRITE_BUFFER_BYTES = 256 * 1024;
    let streamError: unknown = null;
    const onError = (err: unknown) => {
      streamError = err;
    };

    out.on('error', onError);

    const formatStreamError = (e: unknown): string => {
      if (e instanceof Error) return e.message;
      try {
        return JSON.stringify(e);
      } catch {
        return String(e);
      }
    };

    const throwIfStreamErrored = () => {
      if (streamError) {
        throw streamError instanceof Error ? streamError : new Error(formatStreamError(streamError));
      }
    };

    const writeOrDrain = async (chunk: string): Promise<void> => {
      if (chunk.length === 0) {
        return;
      }
      throwIfStreamErrored();
      const ok = out.write(chunk);
      if (!ok) {
        await once(out, 'drain');
      }
      throwIfStreamErrored();
    };

    try {
      let bufferedLines: string[] = [];
      let bufferedBytes = 0;

      for await (const entry of entries) {
        throwIfStreamErrored();

        const line = JSON.stringify(entry) + '\n';
        bufferedLines.push(line);
        bufferedBytes += Buffer.byteLength(line, 'utf8');

        if (bufferedBytes >= WRITE_BUFFER_BYTES) {
          const payload = bufferedLines.join('');
          bufferedLines = [];
          bufferedBytes = 0;
          await writeOrDrain(payload);
        }
      }

      if (bufferedLines.length > 0) {
        await writeOrDrain(bufferedLines.join(''));
      }

      throwIfStreamErrored();

      out.end();
      await once(out, 'finish');
    } finally {
      out.off('error', onError);
      console.log(`Wrote ${path.basename(filePath)} in ${elapsedMs(writeStartedAt).toFixed(0)} ms`);
    }
  }

  private async *mergeChunkFiles(filePaths: string[]): AsyncGenerator<IndexEntry, void, unknown> {
    // Use a binary min-heap (priority queue) to perform an efficient k-way merge.
    // Each heap element holds {key, value, readerIndex} so per-entry selection is O(log k).
    type ChunkReader = {
      reader: AsyncIterableIterator<string>;
      close: () => void;
    };

    const readersStartedAt = process.hrtime.bigint();
    let readerWaitNs = 0n;
    let parseNs = 0n;

    const parseEntry = (line: string): IndexEntry => {
      const parseStartedAt = process.hrtime.bigint();
      const parsed = this.parseEntryLine(line);
      parseNs += process.hrtime.bigint() - parseStartedAt;
      return parsed;
    };

    const chunkReaders: ChunkReader[] = await Promise.all(
      filePaths.map((filePath) => {
        const interfaceReader = createInterface({
          input: createReadStream(filePath, { encoding: 'utf8' }),
          crlfDelay: Infinity,
        });
        const iterator = interfaceReader[Symbol.asyncIterator]();
        return Promise.resolve({ reader: iterator, close: () => interfaceReader.close() });
      }),
    );

    // Heap implementation (min-heap by key)
    type HeapItem = { entry: IndexEntry; readerIndex: number };
    const heap: HeapItem[] = [];

    const heapPush = (item: HeapItem) => {
      heap.push(item);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = Math.floor((i - 1) / 2);
        if (heap[parent].entry.key <= heap[i].entry.key) break;
        const tmp = heap[parent];
        heap[parent] = heap[i];
        heap[i] = tmp;
        i = parent;
      }
    };

    const heapPop = (): HeapItem | undefined => {
      if (heap.length === 0) return undefined;
      const top = heap[0];
      const last = heap.pop() as HeapItem;
      if (heap.length === 0) return top;
      heap[0] = last;
      let i = 0;
      while (true) {
        const left = 2 * i + 1;
        const right = 2 * i + 2;
        let smallest = i;
        if (left < heap.length && heap[left].entry.key < heap[smallest].entry.key) smallest = left;
        if (right < heap.length && heap[right].entry.key < heap[smallest].entry.key) smallest = right;
        if (smallest === i) break;
        const tmp = heap[i];
        heap[i] = heap[smallest];
        heap[smallest] = tmp;
        i = smallest;
      }
      return top;
    };

    try {
      // Prime heap with first entry from each reader
      const primeStartedAt = process.hrtime.bigint();
      await Promise.all(
        chunkReaders.map(async (r, idx) => {
          const waitStartedAt = process.hrtime.bigint();
          const first = await r.reader.next();
          readerWaitNs += process.hrtime.bigint() - waitStartedAt;
          if (!first.done) {
            const parsed = parseEntry(first.value.trim());
            heapPush({ entry: parsed, readerIndex: idx });
          }
        }),
      );
      console.log(
        `Opened ${chunkReaders.length} readers in ${elapsedMs(readersStartedAt).toFixed(0)} ms; primed heap in ${elapsedMs(primeStartedAt).toFixed(0)} ms`,
      );

      let entryCount = 0;
      const mergeStartedAt = process.hrtime.bigint();

      while (true) {
        const smallest = heapPop();
        if (!smallest) break;

        yield smallest.entry;
        entryCount++;

        // Memory check periodically
        if (entryCount % 10000 === 0) {
          const status = this.circuitBreaker.getMemoryStatus();
          if (status.isHardLimitExceeded) {
            throw new Error(
              `Hard memory limit exceeded during merge (${status.percent}%). Consider reducing batch size or increasing Node heap.`,
            );
          }
        }

        // Refill from the same reader
        try {
          const waitStartedAt = process.hrtime.bigint();
          const next = await chunkReaders[smallest.readerIndex].reader.next();
          readerWaitNs += process.hrtime.bigint() - waitStartedAt;
          if (!next.done) {
            const parsed = parseEntry(next.value.trim());
            heapPush({ entry: parsed, readerIndex: smallest.readerIndex });
          }
        } catch (err: unknown) {
          // Handle ERR_USE_AFTER_CLOSE: readline closed prematurely, treat as EOF
          if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
            // Reader closed, skip refill (effectively EOF for this reader)
          } else {
            throw err;
          }
        }
      }

      console.log(
        `Merge stats for ${filePaths.length} file(s): total ${elapsedMs(mergeStartedAt).toFixed(0)} ms, reader wait ${(Number(readerWaitNs) / 1_000_000).toFixed(0)} ms, parse ${(Number(parseNs) / 1_000_000).toFixed(0)} ms`,
      );
    } finally {
      for (const chunkReader of chunkReaders) {
        chunkReader.close();
      }
    }
  }

  /**
   * Multi-pass bounded merge:
   * 1. Divide chunks into groups of MAX_CONCURRENT_CHUNKS
   * 2. Merge each group into an intermediate file
   * 3. Recursively merge intermediate results
   */
  private async *boundedMultiPassMerge(
    filePaths: string[],
    maxConcurrent: number,
  ): AsyncGenerator<IndexEntry, void, unknown> {
    let currentFiles = filePaths;
    let passNumber = 0;

    while (currentFiles.length > maxConcurrent) {
      const passStartedAt = process.hrtime.bigint();
      const intermediateFiles: string[] = [];
      passNumber++;

      // Divide into groups and merge each group
      for (let i = 0; i < currentFiles.length; i += maxConcurrent) {
        const group = currentFiles.slice(i, i + maxConcurrent);
        const groupIndex = Math.floor(i / maxConcurrent);
        const intermediateFile = path.join(
          this.tempDir,
          `index-intermediate-${this.namespace}-p${passNumber}-g${groupIndex}.jsonl`,
        );

        // Merge this group and stream directly to intermediate file
        const groupStartedAt = process.hrtime.bigint();
        await this.writeEntriesToChunkFile(intermediateFile, this.mergeChunkFiles(group));
        console.log(
          `Pass ${passNumber} group ${groupIndex}: ${group.length} file(s) -> ${path.basename(intermediateFile)} in ${elapsedMs(groupStartedAt).toFixed(0)} ms`,
        );
        intermediateFiles.push(intermediateFile);

        // Clean up group files
        await Promise.all(group.map((file) => fs.rm(file, { force: true })));
      }

      currentFiles = intermediateFiles;
      console.log(`Multi-pass merge pass ${passNumber} time: ${elapsedMs(passStartedAt).toFixed(0)} ms`);
    }

    // Final merge of remaining files (<=maxConcurrent)
    yield* this.mergeChunkFiles(currentFiles);

    // Clean up intermediate files
    await Promise.all(currentFiles.map((file) => fs.rm(file, { force: true })));
  }

  /**
   * Clean up temporary files.
   */
  async cleanup(): Promise<void> {
    // Remove explicitly tracked chunk files
    await Promise.all(this.chunkFiles.map((file) => fs.rm(file, { force: true })));
    this.chunkFiles = [];

    // Also attempt to clean up any intermediate or sequential files left behind
    try {
      const entries = await fs.readdir(this.tempDir);
      const prefix1 = `index-intermediate-${this.namespace}-`;
      const prefix2 = `index-seq-${this.namespace}-`;
      const candidates = entries.filter((name) => name.startsWith(prefix1) || name.startsWith(prefix2));
      await Promise.all(candidates.map((name) => fs.rm(path.join(this.tempDir, name), { force: true })));
    } catch {
      // ignore cleanup errors
    }
  }
}
