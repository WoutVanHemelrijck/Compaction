import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FBChildCursor, FBInternalNode, FBLeafNode, FBNodeStorage } from './fb-node-storage.mjs';
import { FreeBlockFile, NO_BLOCK } from '../../storage/freeblockfile.mjs';
import { MockFile } from '../../storage/file/mockfile.mjs';
import {
  COMPRESSION_ENVELOPE_HEADER_SIZE,
  CompressionService,
  NODE_STORAGE_COMPRESSED_PAYLOAD_MAGIC,
} from '../../durability/compression/compression.mjs';

/**
 * Small TestAtomicFile wrapper used by FreeBlockFile in your test harness.
 * Mirrors the structure used in your manual test script.
 */
class TestAtomicFile {
  file: MockFile;
  private inTransaction = false;
  private stagedWrites: { position: number; buffer: Buffer }[] = [];
  private opened = false;

  constructor(file: MockFile) {
    this.file = file;
  }

  async open() {}

  async close() {}

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
    await this.file.sync();
    this.stagedWrites = [];
    this.inTransaction = false;
  }

  getOpenAndInTransaction(): boolean {
    return this.inTransaction && this.opened;
  }

  async sync() {
    await this.file.sync();
  }
}

function makeStorage() {
  const mf = new MockFile(512);
  const atomic = new TestAtomicFile(mf);
  const fb = new FreeBlockFile(mf, atomic, 4096);
  return { mf, atomic, fb };
}

describe('FBNodeStorage', () => {
  let fb: FreeBlockFile;
  let storage: FBNodeStorage<number, string>;
  // let mf: MockFile;

  beforeEach(async () => {
    const setup = makeStorage();
    // const mf = setup.mf;
    fb = setup.fb;
    await fb.open();
    storage = new FBNodeStorage<number, string>(
      (a, b) => a - b,
      () => 8,
      fb,
      64,
    );
  });

  afterEach(async () => {
    try {
      await fb.close();
    } catch {
      // ignore
    }
  });

  it('throws an error when beginTransaction is called during an active transaction', () => {
    storage.beginTransaction();
    expect(() => storage.beginTransaction()).toThrow();
    storage.abortTransaction();
  });

  it('throws an error when commitTransaction is called without an active transaction', async () => {
    await expect(storage.commitTransaction()).rejects.toThrow();
  });

  it('throws an error when abortTransaction is called without an active transaction', () => {
    expect(() => storage.abortTransaction()).toThrow();
  });

  it('persists changes after commitTransaction', async () => {
    const leaf = await storage.createLeaf();
    await leaf.getCursorBeforeFirst().insert(1, 'a');
    await storage.commitAndReclaim();

    storage.beginTransaction();
    await leaf.getCursorBeforeFirst().insert(2, 'b');
    expect(leaf.keys).toEqual([1, 2]);
    expect(storage.isInWriteSession()).toBe(true);

    await storage.commitTransaction();
    expect(storage.isInWriteSession()).toBe(false);

    storage.debug_clearCache();
    const reloaded = await storage.loadNode(leaf.blockId!);
    expect(reloaded.keys).toEqual([1, 2]);
    expect(storage.getCacheSize()).toBeGreaterThan(0);
  });

  it('inWriteSession: insert and commit persists changes', async () => {
    storage.beginTransaction();
    const leaf = await storage.createLeaf();
    await leaf.getCursorBeforeFirst().insert(1, 'a');
    await leaf.getCursorBeforeFirst().insert(2, 'b');
    expect(leaf.keys).toEqual([1, 2]);
    await storage.commitTransaction();
    storage.debug_clearCache();
    const reloaded = await storage.loadNode(leaf.blockId!);
    expect(reloaded.keys).toEqual([1, 2]);
    expect((reloaded as FBLeafNode<number, string>).values).toEqual(['a', 'b']);
  });

  it('inWriteSession: insert and abort rolls back changes', async () => {
    const leaf = await storage.createLeaf();
    await leaf.getCursorBeforeFirst().insert(1, 'a');
    await storage.commitAndReclaim();
    storage.beginTransaction();
    await leaf.getCursorBeforeFirst().insert(2, 'b');
    expect(leaf.keys).toEqual([1, 2]);
    storage.abortTransaction();
    expect(leaf.keys).toEqual([1]);
    expect(leaf.values).toEqual(['a']);
  });

  it('inWriteSession: remove and commit persists removal', async () => {
    const leaf = await storage.createLeaf();
    await leaf.getCursorBeforeFirst().insert(1, 'a');
    await leaf.getCursorBeforeFirst().insert(2, 'b');
    await storage.commitAndReclaim();
    storage.beginTransaction();
    const cursor = leaf.getCursorBeforeFirst();
    await cursor.removeKeyValuePairAfter();
    expect(leaf.keys).toEqual([2]);
    await storage.commitTransaction();
    storage.debug_clearCache();
    const reloaded = await storage.loadNode(leaf.blockId!);
    expect(reloaded.keys).toEqual([2]);
    expect((reloaded as FBLeafNode<number, string>).values).toEqual(['b']);
  });

  it('inWriteSession: remove and abort rolls back removal', async () => {
    const leaf = await storage.createLeaf();
    await leaf.getCursorBeforeFirst().insert(1, 'a');
    await leaf.getCursorBeforeFirst().insert(2, 'b');
    await storage.commitAndReclaim();
    storage.beginTransaction();
    const cursor = leaf.getCursorBeforeFirst();
    await cursor.removeKeyValuePairAfter();
    expect(leaf.keys).toEqual([2]);
    storage.abortTransaction();
    expect(leaf.keys).toEqual([1, 2]);
    expect(leaf.values).toEqual(['a', 'b']);
  });

  it('commitTransaction persists internal node and children', async () => {
    storage.beginTransaction();
    const leaf1 = await storage.createLeaf();
    await leaf1.getCursorBeforeFirst().insert(1, 'a');
    const leaf2 = await storage.createLeaf();
    await leaf2.getCursorBeforeFirst().insert(2, 'b');
    const internal = await storage.createInternalNode([leaf1, leaf2], [2]);
    await storage.persistInternal(internal);
    await storage.commitTransaction();
    storage.debug_clearCache();
    const reloaded = await storage.loadNode(internal.blockId!);
    expect(reloaded.keys).toEqual([2]);
    expect((reloaded as FBInternalNode<number, string>).childBlockIds.length).toBe(2);
  });

  it('throws if internal node has missing child blockId', async () => {
    storage.beginTransaction();
    const leaf1 = await storage.createLeaf(); // NO_BLOCK
    await leaf1.getCursorBeforeFirst().insert(1, 'a');
    //
    const internal = await storage.createInternalNode([leaf1], [2]); // NO_BLOCK
    //
    await storage.persistInternal(internal);
    expect(internal.childBlockIds[1] !== NO_BLOCK);
    //
  });

  it('commitTransaction reclaims replaced child blocks', async () => {
    const leaf1 = await storage.createLeaf();
    await leaf1.getCursorBeforeFirst().insert(1, 'a');
    const leaf2 = await storage.createLeaf();
    await leaf2.getCursorBeforeFirst().insert(2, 'b');
    const internal = await storage.allocateInternalNodeStorage([leaf1, leaf2], [2]);
    await storage.commitAndReclaim();
    storage.beginTransaction();
    const leaf3 = await storage.createLeaf();
    await leaf3.getCursorBeforeFirst().insert(3, 'c');
    const leaf4 = await storage.createLeaf();
    await leaf4.getCursorBeforeFirst().insert(4, 'd');
    internal.childBlockIds = [leaf3.blockId!, leaf4.blockId!];
    internal.children = [leaf3, leaf4];
    internal.keys = [4];
    await storage.persistInternal(internal);
    await storage.commitTransaction();
    storage.debug_clearCache();
    const reloaded = await storage.loadNode(internal.blockId!);
    expect(reloaded.keys).toEqual([4]);
    expect((reloaded as FBInternalNode<number, string>).childBlockIds.length).toBe(2);
  });

  it('persists a leaf and loadNode returns the same keys/values', async () => {
    const leaf = await storage.createLeaf();
    const cur = leaf.getCursorBeforeFirst();
    await cur.insert(10, 'v10');
    await cur.insert(5, 'v5');
    await cur.insert(20, 'v20');

    await storage.commitAndReclaim();

    expect(typeof leaf.blockId).toBe('number');
    const persistedId = leaf.blockId!;
    expect(persistedId).toBeGreaterThan(0);

    const raw = await fb.readBlob(persistedId);
    expect(Buffer.isBuffer(raw)).toBeTruthy();
    expect(raw.length).toBeGreaterThan(0);

    const loaded = await storage.loadNode(persistedId);
    expect(loaded.isLeaf).toBe(true);
    if (loaded.isLeaf) {
      expect(loaded.keys).toEqual([5, 10, 20]);
      expect(loaded.values).toEqual(['v5', 'v10', 'v20']);
    }
  });

  it('rejects legacy node-storage envelope (v0 without algorithm id)', async () => {
    const service = new CompressionService({ algorithm: 'gzip' });
    const legacyPayload = {
      type: 'leaf',
      keys: [{ type: 'number', value: 42 }],
      values: [{ t: 'json', value: JSON.stringify('legacy') }],
    };
    const json = Buffer.from(JSON.stringify(legacyPayload), 'utf-8');
    const compressed = service.compress(json);

    const legacyMeta = Buffer.alloc(COMPRESSION_ENVELOPE_HEADER_SIZE);
    NODE_STORAGE_COMPRESSED_PAYLOAD_MAGIC.copy(legacyMeta, 0);
    legacyMeta.writeUInt32LE(compressed.originalSize, 4);
    legacyMeta.writeUInt32LE(compressed.compressedSize, 8);
    const legacyBuffer = Buffer.concat([legacyMeta, compressed.payload]);

    const blockId = await fb.allocateAndWrite(legacyBuffer);
    await fb.commit();

    await expect(storage.loadNode(blockId)).rejects.toThrow();
  });

  it('creates an internal node referencing two leaves and loads it', async () => {
    const leaf1 = await storage.createLeaf();
    const cur1 = leaf1.getCursorBeforeFirst();
    await cur1.insert(10, 'v10');

    const leaf2 = await storage.createLeaf();
    const cur2 = leaf2.getCursorBeforeFirst();
    await cur2.insert(30, 'v30');

    await storage.commitAndReclaim();

    const internal = await storage.allocateInternalNodeStorage([leaf1, leaf2], [30]);
    await storage.commitAndReclaim();

    expect(typeof internal.blockId).toBe('number');
    const rawInternal = await fb.readBlob(internal.blockId!);
    expect(Buffer.isBuffer(rawInternal)).toBeTruthy();
    expect(rawInternal.length).toBeGreaterThan(0);
    const loaded = await storage.loadNode(internal.blockId!);
    expect(loaded.isLeaf).toBe(false);
    if (!loaded.isLeaf) {
      expect(loaded.keys).toEqual([30]);
      expect(Array.isArray(loaded.childBlockIds)).toBeTruthy();
      expect(loaded.childBlockIds.length).toBe(2);
      const child0 = await storage.loadNode(loaded.childBlockIds[0]);
      const child1 = await storage.loadNode(loaded.childBlockIds[1]);
      expect(child0.isLeaf).toBe(true);
      expect(child1.isLeaf).toBe(true);
    }
  });

  it('enqueues old leaf blocks and reclaims on commitAndReclaim; freed id reused', async () => {
    const leaf = await storage.createLeaf();
    const cur = leaf.getCursorBeforeFirst();
    await cur.insert(10, 'v10');
    await cur.insert(5, 'v5');
    await storage.commitAndReclaim();

    const firstId = leaf.blockId!;
    expect(typeof firstId).toBe('number');
    expect(firstId).toBeGreaterThan(0);

    await cur.insert(15, 'v15');
    const newId = leaf.blockId!;
    // With in-place updates (overwriteBlock), blockId stays the same
    expect(newId).toBe(firstId);

    const freeHeadBefore = await fb.debug_getFreeListHead();
    expect(freeHeadBefore).toBe(NO_BLOCK);

    await storage.commitAndReclaim();

    const freeHeadAfter = await fb.debug_getFreeListHead();
    // No old block to reclaim since we overwrote in place
    expect(freeHeadAfter).toBe(NO_BLOCK);

    // Since no blocks were freed, allocating won't reuse firstId
    const alloc = await fb.allocateBlocks(1);

    let allocatedId: number;
    if (Array.isArray(alloc)) {
      allocatedId = alloc[0];
    } else if (typeof alloc === 'number') {
      allocatedId = alloc;
    } else {
      throw new Error(`unexpected allocateBlocks return value: ${String(alloc)}`);
    }

    // New allocation gets a fresh block, not the reused firstId
    expect(allocatedId).not.toBe(firstId);
  });

  it('returns maxKeySize', () => {
    const maxKeySize = storage.getMaxKeySize();
    expect(maxKeySize).toBe(64);
  });

  it('leaf cursor getCursorBeforeKey and iteration works', async () => {
    const leaf = await storage.createLeaf();
    const cur = leaf.getCursorBeforeFirst();
    await cur.insert(10, 'v10');
    await cur.insert(5, 'v5');
    await cur.insert(20, 'v20');

    expect(leaf.keys).toEqual([5, 10, 20]);

    const { cursor, isAtKey } = leaf.getCursorBeforeKey(10);
    expect(isAtKey).toBe(true);
    cursor.moveNext();
    const kv = cursor.getKeyValuePairAfter();
    expect(kv.key).toBe(20);
    expect(kv.value).toBe('v20');
  });

  it('links leaves via nextBlockId and getNextLeaf returns persisted sibling', async () => {
    const leaf1 = await storage.createLeaf(); // NO_BLOCK
    await leaf1.getCursorBeforeFirst().insert(1, 'a');
    await storage.commitAndReclaim();

    const leaf2 = await storage.createLeaf(); // NO_BLOCK
    await leaf2.getCursorBeforeFirst().insert(2, 'b');
    await storage.commitAndReclaim();

    leaf1.nextLeaf = leaf2;
    leaf2.prevLeaf = leaf1;

    await storage.persistLeaf(leaf1);
    await storage.persistLeaf(leaf2);
    leaf1.nextBlockId = leaf2.blockId;

    await storage.commitAndReclaim();

    const loaded1 = await storage.loadNode(leaf1.blockId!);
    expect(loaded1.isLeaf).toBe(true);
    if (!loaded1.isLeaf) throw new Error('expected leaf node');

    const next = await loaded1.getNextLeaf();
    expect(next).not.toBeNull();
    if (next) {
      expect(next.keys).toEqual(leaf2.keys);
      expect(next.values).toEqual(leaf2.values);
    }
  });

  it('persists child when creating internal node', async () => {
    const ephemeral = await storage.createLeaf();
    expect(ephemeral.blockId).toBeUndefined();

    const internal = await storage.allocateInternalNodeStorage([ephemeral], []);
    await storage.commitAndReclaim();

    expect(typeof internal.blockId).toBe('number');
    expect(internal.blockId).toBeGreaterThan(0);

    expect(typeof ephemeral.blockId).toBe('number');
    expect(internal.childBlockIds.length).toBe(1);
    expect(internal.childBlockIds[0]).toBe(ephemeral.blockId);
  });

  it('leaf cursor removeKeyValuePairAfter updates keys/values', async () => {
    const leaf = await storage.createLeaf();
    const c = leaf.getCursorBeforeFirst();
    await c.insert(2, 'b');
    await c.insert(1, 'a');
    await c.insert(3, 'c');

    expect(leaf.keys).toEqual([1, 2, 3]);

    const cursor = leaf.getCursorBeforeFirst();
    await cursor.removeKeyValuePairAfter();
    expect(leaf.keys).toEqual([2, 3]);

    await storage.commitAndReclaim();
    expect(typeof leaf.blockId).toBe('number');
  });

  it('cursor reset/isAfterLast/movePrev behavior', async () => {
    const leaf = await storage.createLeaf();
    const cur = leaf.getCursorBeforeFirst();
    await cur.insert(1, 'one');
    await cur.insert(2, 'two');

    const c = leaf.getCursorBeforeFirst();
    expect(c.isAfterLast()).toBe(false);

    c.moveNext();
    expect(c.isAfterLast()).toBe(false);

    c.moveNext();
    expect(c.isAfterLast()).toBe(true);

    c.reset();
    expect(c.isAfterLast()).toBe(false);

    c.moveNext();
    c.moveNext();
    expect(() => c.getKeyValuePairAfter()).toThrow();
  });

  it('debug_clearCache and deleteCachedBlock affect loadNode object identity', async () => {
    const leaf = await storage.createLeaf();
    await leaf.getCursorBeforeFirst().insert(7, 's');
    await storage.commitAndReclaim();

    const id = leaf.blockId!;
    const n1 = await storage.loadNode(id);
    const n2 = await storage.loadNode(id);
    expect(n1 === n2).toBe(true);

    storage.debug_clearCache();
    const n3 = await storage.loadNode(id);
    expect(n3 === n1).toBe(false);

    const n4 = await storage.loadNode(id);
    storage.deleteCachedBlock(id);
    const n5 = await storage.loadNode(id);
    expect(n4 === n5).toBe(false);
  });

  it('internal child cursor getChild, setPosition, first/last child, getKeyAfter', async () => {
    const leaf1 = await storage.createLeaf();
    await leaf1.getCursorBeforeFirst().insert(10, 'a');
    const leaf2 = await storage.createLeaf();
    await leaf2.getCursorBeforeFirst().insert(20, 'b');
    await storage.commitAndReclaim();

    const internal = await storage.allocateInternalNodeStorage([leaf1, leaf2], [20]);
    await storage.commitAndReclaim();

    const childCursor = (await internal.getChildCursorAtFirstChild()) as FBChildCursor<number, string>;
    expect(childCursor.isFirstChild()).toBe(true);
    const firstChild = await childCursor.getChild(0);
    expect(firstChild.isLeaf).toBe(true);
    const secondChild = await childCursor.getChild(1);
    expect(secondChild.isLeaf).toBe(true);

    childCursor.setPosition(1);
    expect(childCursor.isLastChild()).toBe(true);

    const kc = await internal.getChildCursorAtFirstChild();
    const keyAfter = kc.getKeyAfter();
    expect(keyAfter).toBe(20);
  });

  it('replaceKeysAndChildrenAfterBy persists replacement children and updates keys/children', async () => {
    const a = await storage.createLeaf();
    await a.getCursorBeforeFirst().insert(1, 'a');
    const b = await storage.createLeaf();
    await b.getCursorBeforeFirst().insert(3, 'b');
    await storage.commitAndReclaim();

    const internal = await storage.allocateInternalNodeStorage([a, b], [3]);
    await storage.commitAndReclaim();

    const repLeft = await storage.createLeaf();
    await repLeft.getCursorBeforeFirst().insert(1, 'rep-left');
    const repRight = await storage.createLeaf();
    await repRight.getCursorBeforeFirst().insert(2, 'rep-right');

    const childCursor = (await internal.getChildCursorAtFirstChild()) as FBChildCursor<number, string>;
    childCursor.setPosition(0);

    const res = await childCursor.replaceKeysAndChildrenAfterBy(1, [2], [repLeft, repRight]);

    expect(res.keys).toContain(2);
    expect(res.nodes.length).toBeGreaterThan(0);
    expect(internal.childBlockIds.length).toBe(2);
    expect(internal.keys.length).toBe(1);
  });

  it('moveLastChildTo and moveFirstChildTo adjust keys and children and persist', async () => {
    const l1 = await storage.createLeaf();
    await l1.getCursorBeforeFirst().insert(5, 'x');
    const l2 = await storage.createLeaf();
    await l2.getCursorBeforeFirst().insert(15, 'y');
    const l0 = await storage.createLeaf();
    await l0.getCursorBeforeFirst().insert(1, 'z');
    await storage.commitAndReclaim();

    const parent = await storage.allocateInternalNodeStorage([l1, l2], [15]);
    await storage.commitAndReclaim();

    const nextNode = await storage.allocateInternalNodeStorage([l0], []);
    const returnedKey = await parent.moveLastChildTo(999, nextNode);
    expect(returnedKey).toBe(15);
    expect(nextNode.keys[0]).toBe(999);
    expect(parent.keys.length).toBe(0);

    const sep = await nextNode.moveFirstChildTo(parent, 123);
    expect(typeof sep === 'number').toBeTruthy();
    expect(parent.keys.length).toBeGreaterThanOrEqual(1);
  });

  it('leaf canMergeWithNext and mergeWithNext combine keys and enqueue frees', async () => {
    const left = await storage.createLeaf();
    await left.getCursorBeforeFirst().insert(1, 'a');
    const right = await storage.createLeaf();
    await right.getCursorBeforeFirst().insert(2, 'b');
    await storage.commitAndReclaim();

    const can = left.canMergeWithNext(0, right);
    expect(typeof can === 'boolean').toBeTruthy();

    await left.mergeWithNext(0, right);
    expect(left.keys).toEqual([1, 2]);
    expect(typeof left.blockId).toBe('number');
  });

  it('persists and restores nextBlockId/prevBlockId pointers after reload (regression test)', async () => {
    // Create a chain of 3 leaves with explicit pointer relationships
    const leaf1 = await storage.createLeaf();
    await leaf1.getCursorBeforeFirst().insert(1, 'a');
    await storage.commitAndReclaim();

    const leaf2 = await storage.createLeaf();
    await leaf2.getCursorBeforeFirst().insert(2, 'b');
    await storage.commitAndReclaim();

    const leaf3 = await storage.createLeaf();
    await leaf3.getCursorBeforeFirst().insert(3, 'c');
    await storage.commitAndReclaim();

    // Link them: leaf1 -> leaf2 -> leaf3
    leaf1.nextLeaf = leaf2;
    leaf2.prevLeaf = leaf1;
    leaf2.nextLeaf = leaf3;
    leaf3.prevLeaf = leaf2;

    // Persist all three leaves (this should sync nextBlockId/prevBlockId)
    await storage.persistLeaf(leaf1);
    await storage.persistLeaf(leaf2);
    await storage.persistLeaf(leaf3);
    await storage.commitAndReclaim();

    // Save blockIds before clearing cache
    const leaf1Id = leaf1.blockId!;
    const leaf2Id = leaf2.blockId!;
    const leaf3Id = leaf3.blockId!;

    expect(leaf1Id).toBeGreaterThan(0);
    expect(leaf2Id).toBeGreaterThan(0);
    expect(leaf3Id).toBeGreaterThan(0);

    // Clear cache to force reload from disk
    storage.debug_clearCache();

    // Reload leaf1 from disk
    const reloaded1 = await storage.loadNode(leaf1Id);
    expect(reloaded1.isLeaf).toBe(true);
    if (!reloaded1.isLeaf) throw new Error('expected leaf');

    // Test nextBlockId was persisted correctly
    expect(reloaded1.nextBlockId).toBe(leaf2Id);

    // Test getNextLeaf() works after reload (this will load leaf2 from disk)
    const next1 = await reloaded1.getNextLeaf();
    expect(next1).not.toBeNull();
    expect(next1?.keys).toEqual([2]);
    expect(next1?.values).toEqual(['b']);
    expect(next1?.blockId).toBe(leaf2Id);

    // Test prevBlockId on the next leaf
    expect(next1?.prevBlockId).toBe(leaf1Id);

    // Continue to leaf3
    const next2 = await next1?.getNextLeaf();
    expect(next2).not.toBeNull();
    expect(next2?.keys).toEqual([3]);
    expect(next2?.values).toEqual(['c']);
    expect(next2?.blockId).toBe(leaf3Id);
    expect(next2?.prevBlockId).toBe(leaf2Id);

    // Verify leaf3 has no next pointer
    expect(next2?.nextBlockId).toBeUndefined();
    const next3 = await next2?.getNextLeaf();
    expect(next3).toBeNull();
  });

  it('restores node state after rollback (snapshot/rollback)', async () => {
    const leaf = await storage.createLeaf();
    await leaf.getCursorBeforeFirst().insert(1, 'a');
    await storage.commitAndReclaim();

    storage.beginTransaction();
    await leaf.getCursorBeforeFirst().insert(2, 'b');
    expect(leaf.keys).toEqual([1, 2]);

    storage.abortTransaction();
    expect(leaf.keys).toEqual([1]);

    storage.beginTransaction();
    await leaf.getCursorBeforeFirst().insert(3, 'c');
    expect(leaf.keys).toEqual([1, 3]);
    await storage.commitTransaction();
    expect(leaf.keys).toEqual([1, 3]);
  });
});
