// @author Mathias Bouhon Keulen
// @date 2025-11-09

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BPlusTree } from '../indexes/b-plus-tree.mjs';
import {
  TrivialNodeStorage,
  TrivialLeafNode,
  TrivialInternalNode,
} from '../storage/node-storage/trivial-node-storage.mjs';

/**
 * Collects all values from an async generator or async iterable into an array.
 *
 * @template T - The type of values yielded by the generator or iterable.
 * @param {AsyncGenerator<T, void, unknown> | AsyncIterable<T>} gen - The async generator or iterable to collect from.
 * @returns {Promise<T[]>} A promise that resolves to an array of collected values.
 */
async function collectAsync<T>(gen: AsyncGenerator<T, void, unknown> | AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) {
    out.push(v);
  }
  return out;
}

describe('BPlusTree', () => {
  let tree: BPlusTree<number, string, TrivialLeafNode<number, string>, TrivialInternalNode<number, string>>;

  beforeEach(async () => {
    const storage = new TrivialNodeStorage<number, string>(
      (a, b) => a - b,
      (_k) => 4,
    );
    tree = new BPlusTree<number, string, TrivialLeafNode<number, string>, TrivialInternalNode<number, string>>(
      storage,
      3,
    );
    await tree.init();
  });

  it('throws for order < 1', () => {
    const storage = new TrivialNodeStorage<number, string>(
      (a, b) => a - b,
      (_k) => 4,
    );
    expect(() => {
      new BPlusTree<number, string, TrivialLeafNode<number, string>, TrivialInternalNode<number, string>>(storage, 0);
    }).toThrow();
  });

  it('printTree prints one-line-per-level structure', async () => {
    const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    for (const k of keys) await tree.insert(k, `val${k}`);

    await tree.delete(1);
    await tree.delete(5);
    await tree.delete(9);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    tree.printTree();

    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy.mock.calls[0][0]).toBe('Internal(keys:4,7)');
    expect(logSpy.mock.calls[1][0]).toBe('Leaf(2,3) | Leaf(4,6) | Leaf(7,8)');

    logSpy.mockRestore();
  });

  it('ascii prints expected ascii-art for a small deterministic tree', async () => {
    const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    for (const k of keys) await tree.insert(k, `val${k}`);

    await tree.delete(1);
    await tree.delete(5);
    await tree.delete(9);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    tree.ascii();

    const expected = [
      '        [4,7]        ',
      '  --------|--------  ',
      '  |       |       |  ',
      '[2,3]   [4,6]   [7,8]',
    ];

    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.length).toBe(expected.length);
    expect(calls).toEqual(expected);

    logSpy.mockRestore();
  });

  it('inserts and searches values', async () => {
    await tree.insert(10, 'v10');
    await tree.insert(5, 'v5');
    await tree.insert(20, 'v20');

    expect(await tree.search(10)).toBe('v10');
    expect(await tree.search(5)).toBe('v5');
    expect(await tree.search(20)).toBe('v20');
    expect(await tree.search(999)).toBeNull();
  });

  it('entries yields entries in sorted order and async-iterator works', async () => {
    const keys = [10, 1, 7, 3, 12, 5, 9];
    for (const k of keys) await tree.insert(k, `value-${k}`);

    const entries = await collectAsync<{ key: number; value: string }>(tree.entries());
    const keysFromEntries = entries.map((e) => e.key);
    expect(keysFromEntries).toEqual([...keys].sort((a, b) => a - b));

    const iterated: number[] = [];
    for await (const { key } of tree) {
      iterated.push(key);
    }
    expect(iterated).toEqual([...keys].sort((a, b) => a - b));
  });

  it('keys() and values() yield correct sequences', async () => {
    const keys = [4, 2, 6, 8, 0];
    for (const k of keys) await tree.insert(k, `val-${k}`);

    const keysList = await collectAsync<number>(tree.keys());
    const valuesList = await collectAsync<string>(tree.values());

    expect(keysList).toEqual([...keys].sort((a, b) => a - b));
    expect(valuesList).toEqual([...keys].sort((a, b) => a - b).map((k) => `val-${k}`));
  });

  it('entriesFrom(startKey) starts at first >= startKey and yields nothing past end', async () => {
    const keys = [1, 3, 5, 7, 9, 11, 13, 15];
    for (const k of keys) await tree.insert(k, `v${k}`);

    const from13 = await collectAsync<{ key: number; value: string }>(tree.entriesFrom(13));
    expect(from13.map((e) => e.key)).toEqual([13, 15]);

    const from6 = await collectAsync<{ key: number; value: string }>(tree.entriesFrom(6));
    expect(from6.map((e) => e.key)).toEqual([7, 9, 11, 13, 15]);
  });

  it('entriesFrom(startKey) scans across leaf boundaries without restarting the search', async () => {
    const keys = Array.from({ length: 120 }, (_, index) => index * 2);
    for (const key of keys) await tree.insert(key, `v${key}`);

    const from73 = await collectAsync<{ key: number; value: string }>(tree.entriesFrom(73));
    expect(from73.map((e) => e.key)).toEqual(keys.filter((key) => key >= 73));
    expect(from73[0]?.key).toBe(74);
  });

  it('range(start, end) respects inclusive/exclusive flags and comparator', async () => {
    const keys = [2, 4, 6, 8, 10, 12];
    for (const k of keys) await tree.insert(k, `x${k}`);

    const defaultRange = await collectAsync<{ key: number; value: string }>(tree.range(4, 10));
    expect(defaultRange.map((e) => e.key)).toEqual([4, 6, 8]);

    const inclusiveRange = await collectAsync<{ key: number; value: string }>(
      tree.range(4, 10, { inclusiveStart: true, inclusiveEnd: true }),
    );
    expect(inclusiveRange.map((e) => e.key)).toEqual([4, 6, 8, 10]);

    const exclStart = await collectAsync<{ key: number; value: string }>(
      tree.range(4, 10, { inclusiveStart: false, inclusiveEnd: true }),
    );
    expect(exclStart.map((e) => e.key)).toEqual([6, 8, 10]);
  });

  it('forEach invokes callback in key order and awaits async callbacks', async () => {
    const keys = [20, 5, 15, 25, 10];
    for (const k of keys) await tree.insert(k, `v${k}`);

    const seen: Array<{ k: number; v: string }> = [];
    await tree.forEach(async (k, v) => {
      await new Promise((r) => setTimeout(r, 1));
      seen.push({ k, v });
    });

    expect(seen.map((s) => s.k)).toEqual([...keys].sort((a, b) => a - b));
    expect(seen.map((s) => s.v)).toEqual(seen.map((s) => `v${s.k}`));
  });

  it('delete removes keys and traversal reflects deletions (including underflow handling)', async () => {
    const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    for (const k of keys) await tree.insert(k, `val${k}`);

    await tree.delete(1);
    await tree.delete(5);
    await tree.delete(9);

    expect(await tree.search(1)).toBeNull();
    expect(await tree.search(5)).toBeNull();
    expect(await tree.search(9)).toBeNull();

    const remaining = (await collectAsync<{ key: number }>(tree.entries())).map((e) => e.key);
    // console.log(tree.ascii());
    expect(remaining).toEqual([2, 3, 4, 6, 7, 8]);
  });

  it('clear resets the tree so entries() yields nothing', async () => {
    const keys = [100, 200, 300];
    for (const k of keys) await tree.insert(k, `v${k}`);

    const before = await collectAsync(tree.entries());
    expect(before.length).toBeGreaterThan(0);

    await tree.clear();
    const after = await collectAsync(tree.entries());
    expect(after).toEqual([]);
  });
});
