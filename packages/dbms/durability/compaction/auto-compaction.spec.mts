// @author Wout Van Hemelrijck
// @date 2026-05-05

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimpleDBMS } from '../../core/simpledbms.mjs';
import { MockFile } from '../../storage/file/mockfile.mjs';
import {
  type AutoCompactionCallbacks,
  type AutoCompactionConfig,
  AutoCompactor,
  DEFAULT_AUTO_COMPACTION_CONFIG,
  readAutoCompactionConfigFromEnv,
} from './auto-compaction.mjs';

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Config that fires immediately: zero debounce, zero interval, 1% threshold,
 * no minimum byte requirement. Use in tests that just want to observe
 * compaction triggering without fighting timing guards.
 */
const PERMISSIVE: AutoCompactionConfig = {
  enabled: true,
  fragmentationThreshold: 0.01,
  minFreeBytes: 0,
  minIntervalMs: 0,
  checkDebounceMs: 0,
};

/** Flush the current setImmediate queue (one full event-loop turn). */
async function flushImmediate(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

/**
 * Polls until fn() returns true or the timeout is exceeded.
 * Yields to the event loop on every iteration so pending I/O can progress.
 */
async function waitUntil(fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('waitUntil: timed out');
    await flushImmediate();
  }
}

/**
 * Creates a SimpleDBMS backed by MockFiles with `docCount` documents inserted
 * and `deleteCount` of them subsequently deleted, producing real fragmentation.
 */
async function buildFragmentedDb(docCount = 55, deleteCount = 45) {
  const dbFile = new MockFile(512);
  const walFile = new MockFile(512);
  const db = await SimpleDBMS.create(dbFile, walFile);
  const col = await db.createCollection('items');
  for (let i = 0; i < docCount; i++) {
    await col.insert({ id: `item-${i}`, data: 'x'.repeat(100) });
  }
  for (let i = 0; i < deleteCount; i++) {
    await col.delete(`item-${i}`);
  }
  await db.commit();
  return { db, dbFile, walFile };
}

/**
 * Builds callbacks and a shrink call tracker for an AutoCompactor.
 * The `db` box is updated in-place after each successful shrink so the
 * compactor always uses the freshly-reopened instance.
 */
function makeCallbacks(
  box: { db: SimpleDBMS },
  dbFile: MockFile,
  walFile: MockFile,
): { callbacks: AutoCompactionCallbacks; shrinkCount: () => number } {
  let count = 0;
  const callbacks: AutoCompactionCallbacks = {
    getFreeBlockFile: () => box.db.getFreeBlockFile(),
    onShrinkComplete: async () => {
      await box.db.close();
      box.db = await SimpleDBMS.open(dbFile, walFile);
      count++;
    },
  };
  return { callbacks, shrinkCount: () => count };
}

// ── DEFAULT_AUTO_COMPACTION_CONFIG ────────────────────────────────────────────

describe('DEFAULT_AUTO_COMPACTION_CONFIG', () => {
  it('is enabled by default', () => {
    expect(DEFAULT_AUTO_COMPACTION_CONFIG.enabled).toBe(true);
  });

  it('has a 30% fragmentation threshold', () => {
    expect(DEFAULT_AUTO_COMPACTION_CONFIG.fragmentationThreshold).toBe(0.3);
  });

  it('requires at least 4 MiB of free space', () => {
    expect(DEFAULT_AUTO_COMPACTION_CONFIG.minFreeBytes).toBe(4 * 1024 * 1024);
  });

  it('enforces a 60-second minimum interval between compactions', () => {
    expect(DEFAULT_AUTO_COMPACTION_CONFIG.minIntervalMs).toBe(60_000);
  });

  it('debounces fragmentation checks at 5 seconds', () => {
    expect(DEFAULT_AUTO_COMPACTION_CONFIG.checkDebounceMs).toBe(5_000);
  });
});

// ── readAutoCompactionConfigFromEnv ──────────────────────────────────────────

describe('readAutoCompactionConfigFromEnv', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns all defaults when no env variables are set', () => {
    const cfg = readAutoCompactionConfigFromEnv();
    expect(cfg).toEqual(DEFAULT_AUTO_COMPACTION_CONFIG);
  });

  it('disables compaction when AUTO_COMPACT is "false"', () => {
    vi.stubEnv('AUTO_COMPACT', 'false');
    expect(readAutoCompactionConfigFromEnv().enabled).toBe(false);
  });

  it('keeps compaction enabled for any value other than "false"', () => {
    for (const v of ['true', '1', 'yes', '']) {
      vi.stubEnv('AUTO_COMPACT', v);
      expect(readAutoCompactionConfigFromEnv().enabled).toBe(true);
    }
  });

  it('reads AUTO_COMPACT_THRESHOLD as a float', () => {
    vi.stubEnv('AUTO_COMPACT_THRESHOLD', '0.25');
    expect(readAutoCompactionConfigFromEnv().fragmentationThreshold).toBe(0.25);
  });

  it('reads AUTO_COMPACT_MIN_BYTES as an integer', () => {
    vi.stubEnv('AUTO_COMPACT_MIN_BYTES', '8388608');
    expect(readAutoCompactionConfigFromEnv().minFreeBytes).toBe(8_388_608);
  });

  it('reads AUTO_COMPACT_MIN_INTERVAL_MS as an integer', () => {
    vi.stubEnv('AUTO_COMPACT_MIN_INTERVAL_MS', '120000');
    expect(readAutoCompactionConfigFromEnv().minIntervalMs).toBe(120_000);
  });

  it('reads AUTO_COMPACT_CHECK_DEBOUNCE_MS as an integer', () => {
    vi.stubEnv('AUTO_COMPACT_CHECK_DEBOUNCE_MS', '10000');
    expect(readAutoCompactionConfigFromEnv().checkDebounceMs).toBe(10_000);
  });

  it('falls back to default threshold for non-numeric values', () => {
    vi.stubEnv('AUTO_COMPACT_THRESHOLD', 'banana');
    expect(readAutoCompactionConfigFromEnv().fragmentationThreshold).toBe(
      DEFAULT_AUTO_COMPACTION_CONFIG.fragmentationThreshold,
    );
  });

  it('falls back to default threshold when value is out of (0, 1) range', () => {
    for (const bad of ['0', '1', '1.5', '-0.1']) {
      vi.stubEnv('AUTO_COMPACT_THRESHOLD', bad);
      expect(readAutoCompactionConfigFromEnv().fragmentationThreshold).toBe(
        DEFAULT_AUTO_COMPACTION_CONFIG.fragmentationThreshold,
      );
    }
  });

  it('accepts 0 as a valid value for minFreeBytes and interval/debounce fields', () => {
    vi.stubEnv('AUTO_COMPACT_MIN_BYTES', '0');
    vi.stubEnv('AUTO_COMPACT_MIN_INTERVAL_MS', '0');
    vi.stubEnv('AUTO_COMPACT_CHECK_DEBOUNCE_MS', '0');
    const cfg = readAutoCompactionConfigFromEnv();
    expect(cfg.minFreeBytes).toBe(0);
    expect(cfg.minIntervalMs).toBe(0);
    expect(cfg.checkDebounceMs).toBe(0);
  });
});

// ── AutoCompactor — trigger conditions ───────────────────────────────────────

describe('AutoCompactor trigger conditions', () => {
  it('does not trigger on a fresh empty database', async () => {
    const dbFile = new MockFile(512);
    const walFile = new MockFile(512);
    const db = await SimpleDBMS.create(dbFile, walFile);
    let triggered = false;

    const ac = new AutoCompactor(PERMISSIVE, {
      getFreeBlockFile: () => db.getFreeBlockFile(),
      onShrinkComplete: () => {
        triggered = true;
        return Promise.resolve();
      },
    });

    ac.scheduleCheck();
    await flushImmediate();
    await flushImmediate(); // allow any async reads to settle

    expect(triggered).toBe(false);
    await db.close();
  });

  it('does not trigger when fragmentation is below the threshold', async () => {
    // Insert a few docs, delete only one — very low fragmentation
    const dbFile = new MockFile(512);
    const walFile = new MockFile(512);
    const db = await SimpleDBMS.create(dbFile, walFile);
    const col = await db.createCollection('items');
    for (let i = 0; i < 5; i++) await col.insert({ id: `item-${i}`, value: i });
    await col.delete('item-0'); // ~20% fragmentation at most
    let triggered = false;

    const ac = new AutoCompactor(
      { ...PERMISSIVE, fragmentationThreshold: 0.9 }, // require 90% to trigger
      {
        getFreeBlockFile: () => db.getFreeBlockFile(),
        onShrinkComplete: () => {
          triggered = true;
          return Promise.resolve();
        },
      },
    );

    ac.scheduleCheck();
    await flushImmediate();
    await flushImmediate();

    expect(triggered).toBe(false);
    await db.close();
  });

  it('triggers when fragmentation exceeds the threshold', async () => {
    const { db, dbFile, walFile } = await buildFragmentedDb();
    const box = { db };
    const { callbacks, shrinkCount } = makeCallbacks(box, dbFile, walFile);

    const ac = new AutoCompactor(PERMISSIVE, callbacks);
    ac.scheduleCheck();

    await waitUntil(() => shrinkCount() >= 1);

    expect(shrinkCount()).toBe(1);
    await box.db.close();
  });

  it('does not trigger when minFreeBytes is not satisfied despite a high ratio', async () => {
    // Small DB: high fragmentation ratio but very few free bytes
    const dbFile = new MockFile(512);
    const walFile = new MockFile(512);
    const db = await SimpleDBMS.create(dbFile, walFile);
    const col = await db.createCollection('items');
    for (let i = 0; i < 4; i++) await col.insert({ id: `item-${i}`, v: i });
    await col.delete('item-0');
    await col.delete('item-1'); // ~50% ratio but only a few KB free
    let triggered = false;

    const ac = new AutoCompactor(
      { ...PERMISSIVE, minFreeBytes: 100 * 1024 * 1024 }, // require 100 MiB — impossible for this tiny DB
      {
        getFreeBlockFile: () => db.getFreeBlockFile(),
        onShrinkComplete: () => {
          triggered = true;
          return Promise.resolve();
        },
      },
    );

    ac.scheduleCheck();
    await flushImmediate();
    await flushImmediate();

    expect(triggered).toBe(false);
    await db.close();
  });

  it('triggers only when both threshold AND minFreeBytes conditions are met', async () => {
    const { db, dbFile, walFile } = await buildFragmentedDb();
    const box = { db };
    const { callbacks, shrinkCount } = makeCallbacks(box, dbFile, walFile);

    // Set minFreeBytes to 0 and a very low threshold — both conditions satisfied
    const ac = new AutoCompactor({ ...PERMISSIVE, fragmentationThreshold: 0.01, minFreeBytes: 0 }, callbacks);
    ac.scheduleCheck();

    await waitUntil(() => shrinkCount() >= 1);
    expect(shrinkCount()).toBe(1);
    await box.db.close();
  });
});

// ── AutoCompactor — scheduling mechanics ─────────────────────────────────────

describe('AutoCompactor scheduling mechanics', () => {
  it('multiple rapid scheduleCheck calls collapse into a single check', async () => {
    const { db, dbFile, walFile } = await buildFragmentedDb();
    const box = { db };
    const { callbacks, shrinkCount } = makeCallbacks(box, dbFile, walFile);

    const ac = new AutoCompactor(PERMISSIVE, callbacks);

    // Fire 10 times before the event loop advances
    for (let i = 0; i < 10; i++) ac.scheduleCheck();

    await waitUntil(() => shrinkCount() >= 1);

    // Only one check should have run, triggering exactly one shrink
    expect(shrinkCount()).toBe(1);
    await box.db.close();
  });

  it('does nothing when disabled', async () => {
    const { db } = await buildFragmentedDb();
    let triggered = false;

    const ac = new AutoCompactor(
      { ...PERMISSIVE, enabled: false },
      {
        getFreeBlockFile: () => db.getFreeBlockFile(),
        onShrinkComplete: () => {
          triggered = true;
          return Promise.resolve();
        },
      },
    );

    ac.scheduleCheck();
    await flushImmediate();
    await flushImmediate();

    expect(triggered).toBe(false);
    await db.close();
  });

  it('can be re-triggered after a completed compaction', async () => {
    const { db, dbFile, walFile } = await buildFragmentedDb(55, 45);
    const box = { db };
    const { callbacks, shrinkCount } = makeCallbacks(box, dbFile, walFile);

    const ac = new AutoCompactor(PERMISSIVE, callbacks);

    // First trigger
    ac.scheduleCheck();
    await waitUntil(() => shrinkCount() >= 1);
    expect(shrinkCount()).toBe(1);

    // Re-fragment and trigger again
    const col = await box.db.getCollection('items');
    for (let i = 100; i < 155; i++) await col.insert({ id: `item-${i}`, data: 'x'.repeat(100) });
    for (let i = 100; i < 145; i++) await col.delete(`item-${i}`);

    ac.scheduleCheck();
    await waitUntil(() => shrinkCount() >= 2);
    expect(shrinkCount()).toBe(2);

    await box.db.close();
  });
});

// ── AutoCompactor — debounce and rate limiting ────────────────────────────────

describe('AutoCompactor debounce and rate limiting', () => {
  it('skips a check that falls within the checkDebounceMs window', async () => {
    const { db, dbFile, walFile } = await buildFragmentedDb();
    const box = { db };
    const { callbacks, shrinkCount } = makeCallbacks(box, dbFile, walFile);

    // Large debounce — must not expire during this test regardless of machine speed
    const ac = new AutoCompactor({ ...PERMISSIVE, checkDebounceMs: 60_000 }, callbacks);

    // First call — runs check, triggers compaction
    ac.scheduleCheck();
    await waitUntil(() => shrinkCount() >= 1);
    expect(shrinkCount()).toBe(1);

    // Re-fragment
    const col = await box.db.getCollection('items');
    for (let i = 100; i < 155; i++) await col.insert({ id: `item-${i}`, data: 'x'.repeat(100) });
    for (let i = 100; i < 145; i++) await col.delete(`item-${i}`);

    // Second call immediately — well within the 60 s window
    ac.scheduleCheck();
    await flushImmediate();
    await flushImmediate();

    // Count must not have increased (debounce blocked it)
    expect(shrinkCount()).toBe(1);
    await box.db.close();
  });

  it('runs a check after the checkDebounceMs window expires', async () => {
    const { db, dbFile, walFile } = await buildFragmentedDb();
    const box = { db };
    const { callbacks, shrinkCount } = makeCallbacks(box, dbFile, walFile);

    const ac = new AutoCompactor({ ...PERMISSIVE, checkDebounceMs: 50 }, callbacks);

    // First compaction
    ac.scheduleCheck();
    await waitUntil(() => shrinkCount() >= 1);

    // Re-fragment
    const col = await box.db.getCollection('items');
    for (let i = 100; i < 155; i++) await col.insert({ id: `item-${i}`, data: 'x'.repeat(100) });
    for (let i = 100; i < 145; i++) await col.delete(`item-${i}`);

    // Wait for the debounce window to expire
    await new Promise<void>((r) => setTimeout(r, 80));

    // Now a second check should run
    ac.scheduleCheck();
    await waitUntil(() => shrinkCount() >= 2);
    expect(shrinkCount()).toBe(2);

    await box.db.close();
  });

  it('prevents a second compaction within the minIntervalMs window', async () => {
    const { db, dbFile, walFile } = await buildFragmentedDb();
    const box = { db };
    const { callbacks, shrinkCount } = makeCallbacks(box, dbFile, walFile);

    // Large interval — must not expire during this test regardless of machine speed
    const ac = new AutoCompactor({ ...PERMISSIVE, minIntervalMs: 60_000 }, callbacks);

    // First compaction
    ac.scheduleCheck();
    await waitUntil(() => shrinkCount() >= 1);
    expect(shrinkCount()).toBe(1);

    // Re-fragment
    const col = await box.db.getCollection('items');
    for (let i = 100; i < 155; i++) await col.insert({ id: `item-${i}`, data: 'x'.repeat(100) });
    for (let i = 100; i < 145; i++) await col.delete(`item-${i}`);

    // Schedule immediately — well within the 60 s interval
    ac.scheduleCheck();
    await flushImmediate();
    await flushImmediate();

    expect(shrinkCount()).toBe(1); // blocked by minIntervalMs
    await box.db.close();
  });

  it('allows a second compaction after minIntervalMs has elapsed', async () => {
    const { db, dbFile, walFile } = await buildFragmentedDb();
    const box = { db };
    const { callbacks, shrinkCount } = makeCallbacks(box, dbFile, walFile);

    const ac = new AutoCompactor({ ...PERMISSIVE, minIntervalMs: 50 }, callbacks);

    // First compaction
    ac.scheduleCheck();
    await waitUntil(() => shrinkCount() >= 1);

    // Re-fragment
    const col = await box.db.getCollection('items');
    for (let i = 100; i < 155; i++) await col.insert({ id: `item-${i}`, data: 'x'.repeat(100) });
    for (let i = 100; i < 145; i++) await col.delete(`item-${i}`);

    // Wait past the interval
    await new Promise<void>((r) => setTimeout(r, 80));

    // Second compaction should now be allowed
    ac.scheduleCheck();
    await waitUntil(() => shrinkCount() >= 2);
    expect(shrinkCount()).toBe(2);

    await box.db.close();
  });
});

// ── AutoCompactor — updateConfig ──────────────────────────────────────────────

describe('AutoCompactor updateConfig', () => {
  it('disabling at runtime prevents subsequent compactions', async () => {
    const { db } = await buildFragmentedDb();
    let triggered = false;

    const ac = new AutoCompactor(PERMISSIVE, {
      getFreeBlockFile: () => db.getFreeBlockFile(),
      onShrinkComplete: () => {
        triggered = true;
        return Promise.resolve();
      },
    });

    // Disable before the scheduled check runs
    ac.updateConfig({ enabled: false });

    ac.scheduleCheck();
    await flushImmediate();
    await flushImmediate();

    expect(triggered).toBe(false);
    await db.close();
  });

  it('re-enabling at runtime resumes compaction', async () => {
    const { db, dbFile, walFile } = await buildFragmentedDb();
    const box = { db };
    const { callbacks, shrinkCount } = makeCallbacks(box, dbFile, walFile);

    const ac = new AutoCompactor({ ...PERMISSIVE, enabled: false }, callbacks);

    // Should not fire while disabled
    ac.scheduleCheck();
    await flushImmediate();
    await flushImmediate();
    expect(shrinkCount()).toBe(0);

    // Enable and try again
    ac.updateConfig({ enabled: true });
    ac.scheduleCheck();
    await waitUntil(() => shrinkCount() >= 1);
    expect(shrinkCount()).toBe(1);

    await box.db.close();
  });

  it('raising the threshold prevents compaction that would otherwise fire', async () => {
    const { db } = await buildFragmentedDb();
    let triggered = false;

    // Start with a threshold that would normally trigger
    const ac = new AutoCompactor(PERMISSIVE, {
      getFreeBlockFile: () => db.getFreeBlockFile(),
      onShrinkComplete: () => {
        triggered = true;
        return Promise.resolve();
      },
    });

    // Raise threshold to 99% — extremely fragmented DB still won't reach this
    ac.updateConfig({ fragmentationThreshold: 0.99 });

    ac.scheduleCheck();
    await flushImmediate();
    await flushImmediate();

    expect(triggered).toBe(false);
    await db.close();
  });

  it('lowering the threshold triggers compaction that was previously skipped', async () => {
    const { db, dbFile, walFile } = await buildFragmentedDb();
    const box = { db };
    const { callbacks, shrinkCount } = makeCallbacks(box, dbFile, walFile);

    // Start with a threshold so high nothing triggers
    const ac = new AutoCompactor({ ...PERMISSIVE, fragmentationThreshold: 0.99 }, callbacks);

    ac.scheduleCheck();
    await flushImmediate();
    await flushImmediate();
    expect(shrinkCount()).toBe(0);

    // Lower threshold to something the DB will exceed
    ac.updateConfig({ fragmentationThreshold: 0.01 });

    ac.scheduleCheck();
    await waitUntil(() => shrinkCount() >= 1);
    expect(shrinkCount()).toBe(1);

    await box.db.close();
  });
});

// ── AutoCompactor — error handling ────────────────────────────────────────────

describe('AutoCompactor error handling', () => {
  it('silently skips the check when getFreeBlockFile throws', async () => {
    let triggered = false;

    const ac = new AutoCompactor(PERMISSIVE, {
      getFreeBlockFile: () => {
        throw new Error('FBF unavailable');
      },
      onShrinkComplete: () => {
        triggered = true;
        return Promise.resolve();
      },
    });

    // Should not throw
    ac.scheduleCheck();
    await flushImmediate();
    await flushImmediate();

    expect(triggered).toBe(false);
  });

  it('resets isRunning and remains usable after onShrinkComplete throws', async () => {
    const { db, dbFile, walFile } = await buildFragmentedDb();
    const box = { db };
    let failCount = 0;
    let successCount = 0;

    const ac = new AutoCompactor(PERMISSIVE, {
      getFreeBlockFile: () => box.db.getFreeBlockFile(),
      onShrinkComplete: async () => {
        if (failCount === 0) {
          failCount++;
          // Simulate the host callback throwing (e.g., disk error on reopen)
          throw new Error('reopen failed');
        }
        // Second invocation succeeds — but we need to actually reopen the DB
        await box.db.close();
        box.db = await SimpleDBMS.open(dbFile, walFile);
        successCount++;
      },
    });

    // First attempt — callback throws
    ac.scheduleCheck();
    await flushImmediate();
    await flushImmediate();
    // Give the async error handling time to complete
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(failCount).toBe(1);
    expect(successCount).toBe(0);

    // Re-fragment and try again — the compactor must still be functional
    // (isRunning must have been reset despite the error)
    const col = await box.db.getCollection('items');
    for (let i = 100; i < 155; i++) await col.insert({ id: `item-${i}`, data: 'x'.repeat(100) });
    for (let i = 100; i < 145; i++) await col.delete(`item-${i}`);

    ac.scheduleCheck();
    await waitUntil(() => successCount >= 1);
    expect(successCount).toBe(1);

    await box.db.close();
  });
});

// ── AutoCompactor — integration ───────────────────────────────────────────────

describe('AutoCompactor integration', () => {
  it('auto-shrinks a fragmented database and all remaining data is intact', async () => {
    const { db, dbFile, walFile } = await buildFragmentedDb(55, 45);
    const box = { db };
    const { callbacks, shrinkCount } = makeCallbacks(box, dbFile, walFile);

    const sizeBefore = (await dbFile.stat()).size;

    const ac = new AutoCompactor(PERMISSIVE, callbacks);
    ac.scheduleCheck();
    await waitUntil(() => shrinkCount() >= 1);

    // File must be smaller
    const sizeAfter = (await dbFile.stat()).size;
    expect(sizeAfter).toBeLessThan(sizeBefore);

    // The 10 surviving documents must still be readable
    const col = await box.db.getCollection('items');
    const remaining = await col.find();
    expect(remaining).toHaveLength(10);

    for (let i = 45; i < 55; i++) {
      const doc = await col.findById(`item-${i}`);
      expect(doc).not.toBeNull();
    }

    await box.db.close();
  });

  it('database is fully operational after auto-shrink (insert, update, delete)', async () => {
    const { db, dbFile, walFile } = await buildFragmentedDb(55, 45);
    const box = { db };
    const { callbacks, shrinkCount } = makeCallbacks(box, dbFile, walFile);

    const ac = new AutoCompactor(PERMISSIVE, callbacks);
    ac.scheduleCheck();
    await waitUntil(() => shrinkCount() >= 1);

    const col = await box.db.getCollection('items');

    // Insert
    await col.insert({ id: 'new-1', data: 'hello' });
    expect(await col.findById('new-1')).not.toBeNull();

    // Update
    await col.update('new-1', { data: 'world' });
    const updated = await col.findById('new-1');
    expect(updated!['data']).toBe('world');

    // Delete
    const deleted = await col.delete('new-1');
    expect(deleted).toBe(true);
    expect(await col.findById('new-1')).toBeNull();

    await box.db.close();
  });

  it('persists correctly across a close and reopen after auto-shrink', async () => {
    const { db, dbFile, walFile } = await buildFragmentedDb(55, 45);
    const box = { db };
    const { callbacks, shrinkCount } = makeCallbacks(box, dbFile, walFile);

    const ac = new AutoCompactor(PERMISSIVE, callbacks);
    ac.scheduleCheck();
    await waitUntil(() => shrinkCount() >= 1);

    // Close the post-shrink DB and reopen from disk
    await box.db.close();
    const reopened = await SimpleDBMS.open(dbFile, walFile);
    const col = await reopened.getCollection('items');

    const docs = await col.find();
    expect(docs).toHaveLength(10);

    for (let i = 45; i < 55; i++) {
      expect(await col.findById(`item-${i}`)).not.toBeNull();
    }

    await reopened.close();
  });

  it('handles multiple collections correctly through auto-shrink', async () => {
    const dbFile = new MockFile(512);
    const walFile = new MockFile(512);
    const db = await SimpleDBMS.create(dbFile, walFile);

    const users = await db.createCollection('users');
    const posts = await db.createCollection('posts');

    for (let i = 0; i < 30; i++) {
      await users.insert({ id: `u${i}`, name: `User ${i}` });
      await posts.insert({ id: `p${i}`, title: `Post ${i}` });
    }
    // Delete most to create fragmentation across two collections
    for (let i = 5; i < 30; i++) {
      await users.delete(`u${i}`);
      await posts.delete(`p${i}`);
    }

    const box = { db };
    const { callbacks, shrinkCount } = makeCallbacks(box, dbFile, walFile);

    const ac = new AutoCompactor(PERMISSIVE, callbacks);
    ac.scheduleCheck();
    await waitUntil(() => shrinkCount() >= 1);

    const newUsers = await box.db.getCollection('users');
    const newPosts = await box.db.getCollection('posts');

    expect(await newUsers.find()).toHaveLength(5);
    expect(await newPosts.find()).toHaveLength(5);

    for (let i = 0; i < 5; i++) {
      expect(await newUsers.findById(`u${i}`)).not.toBeNull();
      expect(await newPosts.findById(`p${i}`)).not.toBeNull();
    }

    await box.db.close();
  });
});
