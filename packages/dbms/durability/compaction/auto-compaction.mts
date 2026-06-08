// @author Wout Van Hemelrijck
// @date 2026-05-05
//
// Automatic compaction module.
//
// Monitors database fragmentation after mutating requests and runs
// shrinkDatabase() when the free-block ratio exceeds a configurable threshold.
//
// Operator controls (all via environment variables):
//   AUTO_COMPACT=false                    — disable entirely (default: enabled)
//   AUTO_COMPACT_THRESHOLD=0.30           — fragmentation ratio trigger (default: 0.30 = 30%)
//   AUTO_COMPACT_MIN_BYTES=4194304        — minimum free bytes before triggering (default: 4 MiB)
//   AUTO_COMPACT_MIN_INTERVAL_MS=60000    — minimum ms between two auto-compactions (default: 60 s)
//   AUTO_COMPACT_CHECK_DEBOUNCE_MS=5000   — minimum ms between fragmentation checks (default: 5 s)
//
// Usage:
//   const ac = new AutoCompactor(readAutoCompactionConfigFromEnv(), {
//     getFreeBlockFile: () => db.getFreeBlockFile(),
//     onShrinkComplete: async () => { await db.close(); db = await SimpleDBMS.open(...); },
//     // Required when other operations can run on the same DB concurrently.
//     // The host must guarantee that no insert / update / delete — and no
//     // in-flight read that touches the FreeBlockFile — runs while fn
//     // executes. A writeLock from an RWLock that all routes share is the
//     // expected primitive.
//     runExclusively: (fn) => dbLock.writeLock(fn),
//   });
//   // After each mutating request:
//   ac.scheduleCheck();
//
// Concurrency: shrinkDatabase() rewrites block IDs in place and is not safe
// to run while another operation is mutating the same FreeBlockFile. Hosts
// that accept concurrent writes MUST provide the `runExclusively` callback
// (or otherwise guarantee single-threaded DB access).

import { FreeBlockFile, NO_BLOCK } from '../../storage/freeblockfile.mjs';
import { shrinkDatabase, type ShrinkResult } from './compaction.mjs';

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Configuration for automatic compaction.
 * All fields have defaults via DEFAULT_AUTO_COMPACTION_CONFIG.
 */
export interface AutoCompactionConfig {
  /** Whether auto-compaction is active. */
  enabled: boolean;
  /**
   * Fraction of free blocks to total blocks that triggers a compaction.
   * E.g. 0.30 means "trigger when 30% or more of all blocks are free".
   */
  fragmentationThreshold: number;
  /**
   * Minimum number of free bytes before auto-compaction is triggered.
   * Prevents running an expensive shrink on tiny databases.
   */
  minFreeBytes: number;
  /** Minimum milliseconds that must elapse between two auto-compactions. */
  minIntervalMs: number;
  /**
   * Minimum milliseconds between consecutive fragmentation checks.
   * Acts as a debounce so burst writes don't re-check on every request.
   */
  checkDebounceMs: number;
}

export const DEFAULT_AUTO_COMPACTION_CONFIG: AutoCompactionConfig = {
  enabled: true,
  fragmentationThreshold: 0.3,
  minFreeBytes: 4 * 1024 * 1024, // 4 MiB
  minIntervalMs: 60_000, // 1 minute
  checkDebounceMs: 5_000, // 5 seconds
};

/**
 * Callbacks the host must supply so the AutoCompactor can access the live
 * database state and perform the post-shrink reopen.
 */
export interface AutoCompactionCallbacks {
  /** Returns the FreeBlockFile of the currently open database. */
  getFreeBlockFile(): FreeBlockFile;
  /**
   * Called immediately after shrinkDatabase() succeeds.
   * The host must close the old SimpleDBMS instance and reopen a fresh one
   * from disk, updating its own reference, before this promise resolves.
   */
  onShrinkComplete(): Promise<void>;
  /**
   * Optional. Wraps the shrinkDatabase() call plus onShrinkComplete() in an
   * exclusive critical section. The host is responsible for ensuring that
   * no insert / update / delete (or any other operation that mutates the
   * underlying FreeBlockFile) runs while `fn` is executing.
   *
   * **If omitted, AutoCompactor runs shrinkDatabase() with no exclusion.**
   * shrinkDatabase mutates the live FreeBlockFile in place; a concurrent
   * INSERT will stage writes into the same shared stagedWrites map, and the
   * subsequent commit can drop the new blocks, truncate them off the file,
   * or corrupt the header. Any host that accepts concurrent writes MUST
   * supply this callback (or guarantee single-threaded access by some other
   * means).
   */
  runExclusively?<T>(fn: () => Promise<T>): Promise<T>;
}

// ── AutoCompactor ─────────────────────────────────────────────────────────────

/**
 * Monitors fragmentation and triggers automatic shrinkDatabase() runs.
 *
 * Call scheduleCheck() after each mutating request (insert, update, delete).
 * The compactor debounces calls and enforces a minimum interval between runs
 * so it never storms the database with consecutive compactions.
 */
export class AutoCompactor {
  private config: AutoCompactionConfig;
  private readonly callbacks: AutoCompactionCallbacks;

  private isRunning = false;
  private pendingCheck = false;
  private lastCheckTime = 0;
  private lastCompactionTime = 0;

  constructor(config: AutoCompactionConfig, callbacks: AutoCompactionCallbacks) {
    this.config = { ...config };
    this.callbacks = callbacks;
  }

  /**
   * Schedules a fragmentation check to run after the current event-loop turn.
   * Idempotent: multiple calls before the check executes are collapsed into one.
   * No-op when auto-compaction is disabled or a run is already in progress.
   */
  scheduleCheck(): void {
    if (!this.config.enabled || this.isRunning || this.pendingCheck) return;
    this.pendingCheck = true;
    setImmediate(() => {
      this.pendingCheck = false;
      void this.runCheckIfNeeded();
    });
  }

  /**
   * Overwrite parts of the running configuration at any time.
   * The change takes effect on the next scheduled check.
   */
  updateConfig(patch: Partial<AutoCompactionConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  // ── private ──────────────────────────────────────────────────────────────

  private async runCheckIfNeeded(): Promise<void> {
    if (!this.config.enabled || this.isRunning) return;

    const now = Date.now();
    if (now - this.lastCheckTime < this.config.checkDebounceMs) return;
    if (now - this.lastCompactionTime < this.config.minIntervalMs) return;
    this.lastCheckTime = now;

    let fbf: FreeBlockFile;
    let totalBlocks: number;
    let freeBlocks: number;
    try {
      fbf = this.callbacks.getFreeBlockFile();
      totalBlocks = await fbf.getTotalBlockCount();
      if (totalBlocks <= 1) return;
      freeBlocks = await countFreeBlocks(fbf, totalBlocks);
    } catch {
      // Unable to read FBF state — skip this cycle silently.
      return;
    }

    if (!shouldCompact(freeBlocks, totalBlocks, fbf.blockSize, this.config)) return;

    this.isRunning = true;
    console.log(
      `[AutoCompactor] Fragmentation at ${Math.round((freeBlocks / totalBlocks) * 100)}% ` +
        `(${freeBlocks} of ${totalBlocks} blocks free). Starting auto-shrink...`,
    );

    const doShrink = async (): Promise<ShrinkResult> => {
      const r = await shrinkDatabase(fbf);
      await this.callbacks.onShrinkComplete();
      return r;
    };

    try {
      const result: ShrinkResult = this.callbacks.runExclusively
        ? await this.callbacks.runExclusively(doShrink)
        : await doShrink();
      this.lastCompactionTime = Date.now();
      console.log(
        `[AutoCompactor] Auto-shrink complete: ${result.sizeBefore} → ${result.sizeAfter} bytes ` +
          `(${result.blocksRelocated} blocks relocated).`,
      );
    } catch (err) {
      console.error('[AutoCompactor] Auto-shrink failed:', err);
    } finally {
      this.isRunning = false;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true when fragmentation ratio and absolute free size both exceed
 * the configured thresholds.
 */
function shouldCompact(
  freeBlocks: number,
  totalBlocks: number,
  blockSize: number,
  config: AutoCompactionConfig,
): boolean {
  if (freeBlocks === 0) return false;
  const ratio = freeBlocks / totalBlocks;
  const freeBytes = freeBlocks * blockSize;
  return ratio >= config.fragmentationThreshold && freeBytes >= config.minFreeBytes;
}

/**
 * Walks the FreeBlockFile free list and counts free blocks.
 * O(number of free blocks). Only used for threshold checks; reading stale
 * cached block data is acceptable here.
 */
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

// ── Config from environment ───────────────────────────────────────────────────

/**
 * Reads AutoCompactionConfig from environment variables, falling back to
 * DEFAULT_AUTO_COMPACTION_CONFIG for any variable that is absent or invalid.
 *
 * Variables:
 *   AUTO_COMPACT                  "false" to disable, anything else = enabled
 *   AUTO_COMPACT_THRESHOLD        float, e.g. "0.30"
 *   AUTO_COMPACT_MIN_BYTES        integer bytes, e.g. "4194304"
 *   AUTO_COMPACT_MIN_INTERVAL_MS  integer ms, e.g. "60000"
 *   AUTO_COMPACT_CHECK_DEBOUNCE_MS integer ms, e.g. "5000"
 */
export function readAutoCompactionConfigFromEnv(): AutoCompactionConfig {
  const d = DEFAULT_AUTO_COMPACTION_CONFIG;

  const enabled = process.env['AUTO_COMPACT'] !== 'false';

  const threshold = parseFloat(process.env['AUTO_COMPACT_THRESHOLD'] ?? '');
  const minBytes = parseInt(process.env['AUTO_COMPACT_MIN_BYTES'] ?? '', 10);
  const minInterval = parseInt(process.env['AUTO_COMPACT_MIN_INTERVAL_MS'] ?? '', 10);
  const debounce = parseInt(process.env['AUTO_COMPACT_CHECK_DEBOUNCE_MS'] ?? '', 10);

  return {
    enabled,
    fragmentationThreshold:
      isFinite(threshold) && threshold > 0 && threshold < 1 ? threshold : d.fragmentationThreshold,
    minFreeBytes: isFinite(minBytes) && minBytes >= 0 ? minBytes : d.minFreeBytes,
    minIntervalMs: isFinite(minInterval) && minInterval >= 0 ? minInterval : d.minIntervalMs,
    checkDebounceMs: isFinite(debounce) && debounce >= 0 ? debounce : d.checkDebounceMs,
  };
}
