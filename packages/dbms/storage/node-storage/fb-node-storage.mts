// @author Mathias Bouhon Keulen, Frederick Hillen
// @date 2026-04-24

import {
  debugLog,
  isDebugEnabled,
  debug_incrementFnCallCount,
  debug_incrementOverwriteSource,
  debug_incrementAllocwriteSource,
} from '../../core/debug-global-constants.mjs';

import type {
  NodeStorage,
  NodeBaseStorage,
  LeafNodeStorage,
  InternalNodeStorage,
  LeafCursor,
  ChildCursor,
} from './node-storage.mjs';
import { FreeBlockFile, NO_BLOCK } from '../../storage/freeblockfile.mjs';
import { LRUCache } from './LRU-cache.mjs';
// import { int, lfs } from '../invariants.mjs';

function isNodeTxProfilingEnabled(): boolean {
  return isDebugEnabled();
}

type SerializedKey =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'buffer'; value: string };

function serializeKey(key: unknown): SerializedKey {
  if (Buffer.isBuffer(key) || key instanceof Uint8Array) {
    return { type: 'buffer', value: Buffer.from(key as Uint8Array).toString('base64') };
  }
  const t = typeof key;
  if (t === 'string') return { type: 'string', value: key as string };
  if (t === 'number') return { type: 'number', value: key as number };
  if (t === 'boolean') return { type: 'boolean', value: key as boolean };
  return { type: 'string', value: String(key) };
}

function deserializeKey(serializedKey: SerializedKey): string | number | boolean | Uint8Array {
  if (serializedKey.type === 'buffer') {
    return Buffer.from(serializedKey.value, 'base64');
  }
  return serializedKey.value;
}

type SerializedValue =
  | { t: 'buffer'; value: string }
  | { t: 'json'; value: string }
  | { t: 'string'; value: string }
  | { t: 'number'; value: number }
  | { t: 'boolean'; value: boolean }
  | { t: 'null'; value: null };

function serializeValue(v: unknown): SerializedValue {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array)
    return { t: 'buffer', value: Buffer.from(v as Uint8Array).toString('base64') };
  if (v === null) return { t: 'null', value: null };
  if (typeof v === 'string') return { t: 'string', value: v };
  if (typeof v === 'number') return { t: 'number', value: v };
  if (typeof v === 'boolean') return { t: 'boolean', value: v };
  return { t: 'json', value: JSON.stringify(v) };
}

function deserializeValue(serializedValue: unknown): unknown {
  if (!serializedValue || typeof serializedValue !== 'object') return serializedValue;
  const obj = serializedValue as Record<string, unknown>;
  const t = obj['t'] as string | undefined;
  if (t === 'buffer') return Buffer.from(String(obj['value']), 'base64');
  if (t === 'json') return JSON.parse(String(obj['value']));
  return obj['value'];
}

function lowerBound<Keystype>(
  keys: Keystype[],
  key: Keystype,
  compareKeys: (a: Keystype, b: Keystype) => number,
): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (compareKeys(keys[mid], key) < 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function upperBound<Keystype>(
  keys: Keystype[],
  key: Keystype,
  compareKeys: (a: Keystype, b: Keystype) => number,
): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (compareKeys(keys[mid], key) <= 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

type NodeSnapshot<Keystype, ValuesType> =
  | {
      kind: 'leaf';
      node: FBLeafNode<Keystype, ValuesType>;
      keys: Keystype[];
      values: ValuesType[];
      nextBlockId?: number;
      prevBlockId?: number;
      nextLeaf: FBLeafNode<Keystype, ValuesType> | null;
      prevLeaf: FBLeafNode<Keystype, ValuesType> | null;
      blockId?: number;
    }
  | {
      kind: 'internal';
      node: FBInternalNode<Keystype, ValuesType>;
      keys: Keystype[];
      childBlockIds: number[];
      children: (FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>)[];
      blockId?: number;
    };

/**
 * FBNodeStorage is a NodeStorage implementation that uses FreeBlockFile for storage.
 *
 * @template Keystype - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 */
export class FBNodeStorage<Keystype, ValuesType>
  implements NodeStorage<Keystype, ValuesType, FBLeafNode<Keystype, ValuesType>, FBInternalNode<Keystype, ValuesType>>
{
  private cache: LRUCache<number, FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>> | null;
  private reclaimQueue = new Set<number>();

  private dirtyLeafNodes = new Set<FBLeafNode<Keystype, ValuesType>>();
  private dirtyInternalNodes = new Set<FBInternalNode<Keystype, ValuesType>>();
  private newNodes = new Set<FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>>();
  private Snapshots = new Map<
    FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>,
    NodeSnapshot<Keystype, ValuesType>
  >();
  private reclaimQueueSnapshot: Set<number> | null = null;
  private inWriteSession = false;

  constructor(
    public compareKeys: (a: Keystype, b: Keystype) => number,
    public keySize: (key: Keystype) => number,
    public FBfile: FreeBlockFile,
    private maxKeySize: number,
    cacheCapacity = 100,
  ) {
    this.cache = cacheCapacity > 0 ? new LRUCache(cacheCapacity) : null;
  }

  isInWriteSession(): boolean {
    return this.inWriteSession;
  }

  getCacheSize(): number {
    return this.cache?.size() ?? 0;
  }

  /**
   * Clear in-memory caches and transaction buffers to free memory.
   * This is safe to call after transactional commits when the on-disk
   * representation is authoritative and we want to reduce heap pressure.
   */
  clearMemoryCache(): void {
    this.cache?.clear();
    this.dirtyLeafNodes.clear();
    this.dirtyInternalNodes.clear();
    this.newNodes.clear();
    this.Snapshots.clear();
    this.reclaimQueue = new Set<number>();
    this.reclaimQueueSnapshot = null;
  }

  beginTransaction(): void {
    if (this.inWriteSession) {
      throw new Error('Already in a write session');
    }
    this.dirtyLeafNodes.clear();
    this.dirtyInternalNodes.clear();
    this.newNodes.clear();
    this.Snapshots.clear();
    this.reclaimQueueSnapshot = new Set(this.reclaimQueue);
    this.inWriteSession = true;
  }

  async commitTransaction(): Promise<void> {
    if (!this.inWriteSession) {
      throw new Error('Not in a write session');
    }

    const txStart = isNodeTxProfilingEnabled() ? performance.now() : 0;
    const dirtyLeafCount = this.dirtyLeafNodes.size;
    const dirtyInternalCount = this.dirtyInternalNodes.size;
    const newNodeCount = this.newNodes.size;
    const reclaimCountAtStart = this.reclaimQueue.size;

    let allocationMs = 0;
    let leafPersistMs = 0;
    let internalValidateMs = 0;
    let internalPersistMs = 0;
    let reclaimMs = 0;
    let leafBytesTotal = 0;
    let internalBytesTotal = 0;
    let maxLeafBufferBytes = 0;
    let maxInternalBufferBytes = 0;

    if (this.newNodes.size > 0) {
      const allocationStart = isNodeTxProfilingEnabled() ? performance.now() : 0;
      const allocated = await this.FBfile.allocateBlocks(this.newNodes.size);
      const blockIds = Array.isArray(allocated) ? allocated : [allocated];

      let i = 0;
      for (const node of this.newNodes) {
        node.blockId = blockIds[i++];
      }
      if (isNodeTxProfilingEnabled()) {
        allocationMs = performance.now() - allocationStart;
      }
    }

    const leafPersistStart = isNodeTxProfilingEnabled() ? performance.now() : 0;
    for (const node of this.dirtyLeafNodes) {
      if (node.blockId === undefined || node.blockId === NO_BLOCK) {
        throw new Error('Cannot commit leaf node without a valid blockId');
      }
      // Sync blockId fields from object references before persisting
      // Only update if the object reference exists and has a valid blockId
      if (node.nextLeaf && node.nextLeaf.blockId !== undefined && node.nextLeaf.blockId !== NO_BLOCK) {
        node.nextBlockId = node.nextLeaf.blockId;
      }

      if (node.prevLeaf && node.prevLeaf.blockId !== undefined && node.prevLeaf.blockId !== NO_BLOCK) {
        node.prevBlockId = node.prevLeaf.blockId;
      }
      const payload = {
        type: 'leaf',
        keys: node.keys.map((key) => serializeKey(key)),
        values: node.values.map((value) => serializeValue(value)),
        nextBlockId: node.nextBlockId ?? NO_BLOCK,
        prevBlockId: node.prevBlockId ?? NO_BLOCK,
        version: 1,
      };
      const buffer = this.encodeNodePayload(payload);
      leafBytesTotal += buffer.length;
      if (buffer.length > maxLeafBufferBytes) {
        maxLeafBufferBytes = buffer.length;
      }
      await this.FBfile.overwriteBlock(node.blockId, buffer);
    }
    if (isNodeTxProfilingEnabled()) {
      leafPersistMs = performance.now() - leafPersistStart;
    }

    const internalValidateStart = isNodeTxProfilingEnabled() ? performance.now() : 0;
    for (const node of this.dirtyInternalNodes) {
      const expectedChildren = node.keys.length + 1;
      if (node.childBlockIds.length < expectedChildren) {
        node.childBlockIds = node.childBlockIds.concat(
          Array(expectedChildren - node.childBlockIds.length).fill(NO_BLOCK),
        );
      } else if (node.childBlockIds.length > expectedChildren) {
        node.childBlockIds = node.childBlockIds.slice(0, expectedChildren);
      }
      for (let j = 0; j < expectedChildren; j++) {
        const child = node.children[j];
        if (!child) {
          if (node.childBlockIds[j] === undefined || node.childBlockIds[j] === NO_BLOCK) {
            throw new Error('Internal node child reference is missing blockId');
          }
          continue;
        }

        if (child.blockId === undefined || child.blockId === NO_BLOCK) {
          throw new Error('Cannot commit internal node with unpersisted child');
        }
        node.childBlockIds[j] = child.blockId;
      }
    }
    if (isNodeTxProfilingEnabled()) {
      internalValidateMs = performance.now() - internalValidateStart;
    }

    const internalPersistStart = isNodeTxProfilingEnabled() ? performance.now() : 0;
    for (const node of this.dirtyInternalNodes) {
      if (node.blockId === undefined || node.blockId === NO_BLOCK) {
        throw new Error('Cannot commit internal node without a valid blockId');
      }
      const payload = {
        type: 'internal',
        keys: node.keys.map((key) => serializeKey(key)),
        childBlockIds: node.childBlockIds.slice(),
        version: 1,
      };
      const buffer = this.encodeNodePayload(payload);
      internalBytesTotal += buffer.length;
      if (buffer.length > maxInternalBufferBytes) {
        maxInternalBufferBytes = buffer.length;
      }
      await this.FBfile.overwriteBlock(node.blockId, buffer);
    }
    if (isNodeTxProfilingEnabled()) {
      internalPersistMs = performance.now() - internalPersistStart;
    }

    const reclaimStart = isNodeTxProfilingEnabled() ? performance.now() : 0;
    await this.reclaimQueuedBlocksNow();
    if (isNodeTxProfilingEnabled()) {
      reclaimMs = performance.now() - reclaimStart;
    }

    if (isNodeTxProfilingEnabled()) {
      const totalMs = performance.now() - txStart;
      debugLog(
        `[NODE_TX_PROFILE] total=${totalMs.toFixed(2)}ms alloc=${allocationMs.toFixed(2)}ms leafPersist=${leafPersistMs.toFixed(2)}ms internalValidate=${internalValidateMs.toFixed(2)}ms internalPersist=${internalPersistMs.toFixed(2)}ms reclaim=${reclaimMs.toFixed(2)}ms dirtyLeaf=${dirtyLeafCount} dirtyInternal=${dirtyInternalCount} newNodes=${newNodeCount} reclaimQueueStart=${reclaimCountAtStart} cacheSize=${this.cache?.size() ?? 0} leafBytes=${leafBytesTotal} maxLeafBytes=${maxLeafBufferBytes} internalBytes=${internalBytesTotal} maxInternalBytes=${maxInternalBufferBytes}`,
      );
    }

    this.inWriteSession = false;
    this.dirtyLeafNodes.clear();
    this.dirtyInternalNodes.clear();
    this.newNodes.clear();
    this.Snapshots.clear();
    this.reclaimQueueSnapshot = null;
  }

  abortTransaction(): void {
    if (!this.inWriteSession) {
      throw new Error('Not in a write session');
    }

    for (const snapshot of this.Snapshots.values()) {
      this.restoreSnapshot(snapshot);
    }

    if (this.reclaimQueueSnapshot) {
      this.reclaimQueue = new Set(this.reclaimQueueSnapshot);
    }

    this.dirtyLeafNodes.clear();
    this.dirtyInternalNodes.clear();
    this.newNodes.clear();
    this.Snapshots.clear();
    this.reclaimQueueSnapshot = null;
    this.inWriteSession = false;
  }

  captureSnapshot(node: FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>): void {
    if (!this.inWriteSession) return;
    if (this.Snapshots.has(node)) return;

    if (node.isLeaf) {
      this.Snapshots.set(node, {
        kind: 'leaf',
        node,
        keys: node.keys.slice(),
        values: node.values.slice(),
        nextBlockId: node.nextBlockId,
        prevBlockId: node.prevBlockId,
        nextLeaf: node.nextLeaf,
        prevLeaf: node.prevLeaf,
        blockId: node.blockId,
      });
      return;
    }

    this.Snapshots.set(node, {
      kind: 'internal',
      node,
      keys: node.keys.slice(),
      childBlockIds: node.childBlockIds.slice(),
      children: node.children.slice(),
      blockId: node.blockId,
    });
  }

  private restoreSnapshot(snapshot: NodeSnapshot<Keystype, ValuesType>): void {
    if (snapshot.kind === 'leaf') {
      const node = snapshot.node;
      node.keys = snapshot.keys.slice();
      node.values = snapshot.values.slice();
      node.nextBlockId = snapshot.nextBlockId;
      node.prevBlockId = snapshot.prevBlockId;
      node.nextLeaf = snapshot.nextLeaf;
      node.prevLeaf = snapshot.prevLeaf;
      node.blockId = snapshot.blockId;
      return;
    }

    const node = snapshot.node;
    node.keys = snapshot.keys.slice();
    node.childBlockIds = snapshot.childBlockIds.slice();
    node.children = snapshot.children.slice();
    node.blockId = snapshot.blockId;
  }

  getMaxKeySize(): number {
    return this.maxKeySize;
  }

  private encodeNodePayload(payload: unknown): Buffer {
    // Store node payloads uncompressed. Node payloads are metadata/index structures
    // and we prefer predictable node sizes / faster CPU processing over compression.
    return Buffer.from(JSON.stringify(payload), 'utf-8');
  }

  private decodeNodePayload(buffer: Buffer): Buffer {
    // Node payloads are stored uncompressed; return raw buffer.
    return buffer;
  }

  async createTree(): Promise<FBLeafNode<Keystype, ValuesType>> {
    return this.createLeaf();
  }

  createLeaf(): Promise<FBLeafNode<Keystype, ValuesType>> {
    // assumed that blockId is undefined, not NO_BLOCK.
    const node = new FBLeafNode<Keystype, ValuesType>(this);
    return Promise.resolve(node);
  }

  createInternalNode(
    children: (FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>)[],
    keys: Keystype[],
  ): Promise<FBInternalNode<Keystype, ValuesType>> {
    const childIds = children.map((child) => child.blockId ?? NO_BLOCK);
    const node = new FBInternalNode<Keystype, ValuesType>(this, childIds, keys.slice());
    node.children = children.slice();

    // int({internal: node})  // Had to comment out for a test that forces a different state

    return Promise.resolve(node);
  }

  async allocateInternalNodeStorage(
    children: (FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>)[],
    keys: Keystype[],
  ): Promise<FBInternalNode<Keystype, ValuesType>> {
    // First pass: ensure all children have blockIds
    for (const child of children) {
      if (child.blockId === undefined || child.blockId === NO_BLOCK) {
        if (child.isLeaf) {
          const old = await this.persistLeaf(child);
          //lfs({leaf: child})

          if (typeof old === 'number') this.enqueueForReclaim(old);
        } else {
          const old = await this.persistInternal(child);
          //int({internal: child})

          if (typeof old === 'number') this.enqueueForReclaim(old);
        }
      }
    }

    // Second pass: re-persist all leaf children to sync nextBlockId/prevBlockId pointers
    // This is necessary after splits where pointer relationships were established
    for (const child of children) {
      if (child.isLeaf) {
        //lfs({leaf: child})
        const old = await this.persistLeaf(child);
        //lfs({leaf: child})
        if (typeof old === 'number') this.enqueueForReclaim(old);
      }
    }

    const node = await this.createInternalNode(children, keys);
    if (node.blockId === undefined || node.blockId === NO_BLOCK) {
      //int({internal: node});
      const old = await this.persistInternal(node);
      //int({internal: node});
      if (typeof old === 'number') this.enqueueForReclaim(old);
    }
    return node;
  }

  /*
  // fredje
  async persistLeaf(node: FBLeafNode<Keystype, ValuesType>): Promise<number | undefined> {
    // [DEBUG]
    debug_incrementFnCallCount('persistLeaf()');
    //

    if (this.inWriteSession) {
      this.captureSnapshot(node);
      this.dirtyLeafNodes.add(node);
      if (node.blockId === undefined || node.blockId === NO_BLOCK) {
        this.newNodes.add(node);
      } else {
        this.cache?.set(node.blockId, node);
      }
      return undefined;
    }

    // Sync blockId fields from object references before persisting
    // Only update if the object reference exists and has a valid blockId
    if (node.nextLeaf && node.nextLeaf.blockId !== undefined && node.nextLeaf.blockId !== NO_BLOCK) {
      node.nextBlockId = node.nextLeaf.blockId;
    }

    if (node.prevLeaf && node.prevLeaf.blockId !== undefined && node.prevLeaf.blockId !== NO_BLOCK) {
      node.prevBlockId = node.prevLeaf.blockId;
    }

    const payload = {
      type: 'leaf',
      keys: node.keys.map((key) => serializeKey(key)),
      values: node.values.map((value) => serializeValue(value)),
      nextBlockId: node.nextBlockId ?? NO_BLOCK,
      prevBlockId: node.prevBlockId ?? NO_BLOCK,
      version: 1,
    };
    const buffer = this.encodeNodePayload(payload);

    // In-place update: if node already has a blockId, overwrite it
    if (node.blockId !== undefined && node.blockId !== NO_BLOCK) {
      // [DEBUG]
      debug_incrementOverwriteSource('persistLeaf()');
      //

      await this.FBfile.overwriteBlock(node.blockId, buffer);
      // No old block to reclaim - same blockId
      return undefined;
    }

    // First time: allocate new block

    // [DEBUG]
    debug_incrementAllocwriteSource('persistLeaf()');
    //
    const newBlockId = await this.FBfile.allocateAndWrite(buffer);
    node.blockId = newBlockId;
    this.cache?.set(newBlockId, node);
    return undefined;
  }
  */

  async persistLeaf(node: FBLeafNode<Keystype, ValuesType>): Promise<number | undefined> {
    // [DEBUG]
    debug_incrementFnCallCount('persistLeaf()');
    //

    //
    // lfs({leaf: node});  // -> fails
    //

    if (this.inWriteSession) {
      this.captureSnapshot(node);
      this.dirtyLeafNodes.add(node);
      if (node.blockId === undefined || node.blockId === NO_BLOCK) {
        this.newNodes.add(node);
      } else {
        this.cache?.set(node.blockId, node);
      }
      return undefined;
    }

    //
    if (node.prevLeaf) {
      node.prevBlockId = node.prevLeaf.blockId;
    } else if (node.prevBlockId === undefined) {
      node.prevBlockId = NO_BLOCK;
    }
    // Only update nextBlockId if we have a nextLeaf reference; preserve explicit values
    if (node.nextLeaf) {
      node.nextBlockId = node.nextLeaf.blockId;
    } else if (node.nextBlockId === undefined) {
      node.nextBlockId = NO_BLOCK;
    }
    //

    const payload = {
      type: 'leaf',
      keys: node.keys.map((key) => serializeKey(key)),
      values: node.values.map((value) => serializeValue(value)),
      nextBlockId: node.nextBlockId ?? NO_BLOCK,
      prevBlockId: node.prevBlockId ?? NO_BLOCK,
      version: 1,
    };
    const buffer = this.encodeNodePayload(payload);

    //
    // In-place update: if node already has a blockId, overwrite it
    //
    if (node.blockId !== undefined && node.blockId !== NO_BLOCK) {
      // [DEBUG]
      debug_incrementOverwriteSource('persistLeaf()');
      //

      await this.FBfile.overwriteBlock(node.blockId, buffer);
      // No old block to reclaim - same blockId
      //lfs({leaf: node});
      return undefined;
    }

    //
    // First time: allocate new block
    //

    // [DEBUG]
    debug_incrementAllocwriteSource('persistLeaf()');
    //
    const newBlockId = await this.FBfile.allocateAndWrite(buffer);
    node.blockId = newBlockId;
    this.cache?.set(newBlockId, node);

    // A -> B <- C ; B has const newBlockId, must overwrite A and B.
    if (node.prevLeaf) {
      node.prevLeaf.nextBlockId = newBlockId;
      const payload = {
        type: 'leaf',
        keys: node.prevLeaf.keys.map((key) => serializeKey(key)),
        values: node.prevLeaf.values.map((value) => serializeValue(value)),
        nextBlockId: newBlockId,
        prevBlockId: node.prevLeaf.prevBlockId ?? NO_BLOCK,
        version: 1,
      };
      const buffer = this.encodeNodePayload(payload);
      await this.FBfile.overwriteBlock(node.prevLeaf.blockId as number, buffer);
    }
    if (node.nextLeaf) {
      node.nextLeaf.prevBlockId = newBlockId;
      const payload = {
        type: 'leaf',
        keys: node.nextLeaf.keys.map((key) => serializeKey(key)),
        values: node.nextLeaf.values.map((value) => serializeValue(value)),
        nextBlockId: node.nextLeaf.nextBlockId ?? NO_BLOCK,
        prevBlockId: newBlockId,
        version: 1,
      };
      const buffer = this.encodeNodePayload(payload);
      await this.FBfile.overwriteBlock(node.nextLeaf.blockId as number, buffer);
    }

    //lfs({leaf: node});
    return undefined;
  }

  private async persistInternalShallow(node: FBInternalNode<Keystype, ValuesType>): Promise<number | undefined> {
    //
    // int({internal: node})
    //
    const payload = {
      type: 'internal',
      keys: node.keys.map((key) => serializeKey(key)),
      childBlockIds: node.childBlockIds.slice(),
      version: 1,
    };
    const buffer = this.encodeNodePayload(payload);

    if (node.blockId !== undefined && node.blockId !== NO_BLOCK) {
      // [DEBUG]
      debug_incrementOverwriteSource('persistInternalShallow()');
      //

      await this.FBfile.overwriteBlock(node.blockId, buffer);

      // int({internal: node})
      return undefined;
    }

    // [DEBUG]
    debug_incrementAllocwriteSource('persistInternalShallow()');
    //

    const newBlockId = await this.FBfile.allocateAndWrite(buffer);
    node.blockId = newBlockId;
    this.cache?.set(newBlockId, node);
    return undefined;
  }

  private async markNodeForPersistance(
    node: FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>,
  ): Promise<void> {
    if (this.inWriteSession) {
      this.captureSnapshot(node);
      if (node.blockId !== undefined && node.blockId !== NO_BLOCK) {
        this.cache?.set(node.blockId, node);
      } else {
        this.newNodes.add(node);
      }
      if (node.isLeaf) {
        this.dirtyLeafNodes.add(node);
      } else {
        this.dirtyInternalNodes.add(node);
      }
      return;
    }

    if (node.blockId !== undefined && node.blockId !== NO_BLOCK) return;

    if (node.isLeaf) {
      //lfs({leaf: node});
      const old = await this.persistLeaf(node);
      //lfs({leaf: node});

      if (typeof old === 'number') this.enqueueForReclaim(old);
      return;
    }

    const internalNode = node;
    const hasCompleteChildIds =
      internalNode.childBlockIds.length === internalNode.keys.length + 1 &&
      internalNode.childBlockIds.every((id) => id !== NO_BLOCK && id !== undefined);

    if (hasCompleteChildIds) {
      //int({internal: node});
      const old = await this.persistInternalShallow(internalNode);
      //int({internal: node});

      if (typeof old === 'number') this.enqueueForReclaim(old);
      return;
    }

    //int({internal: node});
    const old = await this.persistInternal(internalNode);
    //int({internal: node});

    if (typeof old === 'number') this.enqueueForReclaim(old);
  }

  /*
    async persistInternal(node: FBInternalNode<Keystype, ValuesType>): Promise<number | undefined> {
    // console.log("PRE", node.childBlockIds);
    if (!node) {
      console.log('gave NULL to persistInternal...', node);
    }

    node.childBlockIds = node.children.map((x) => x.blockId ?? NO_BLOCK);
    // console.log("POST", node.childBlockIds);

    //
    if (node.childBlockIds.some((id) => id === NO_BLOCK || id === undefined)) {
      throw new Error('Cannot persist internal node with unpersisted children');
    }

    //

    // console.log("[PRE] persistInternal()...", node.blockId, node.keys, node.childBlockIds)

    const payload = {
      type: 'internal',
      keys: node.keys.map((key) => serializeKey(key)),
      childBlockIds: node.childBlockIds.slice(),
      version: 1,
    };
    // console.log("PAYLOAD OK")
    //
    const buffer = Buffer.from(JSON.stringify(payload), 'utf-8');
    // console.log("BUFFER OK")

    const newBlockId = await this.FBfile.allocateAndWrite(buffer);
    // console.log("ALLOCATION OK")

    const oldBlockId = node.blockId;

    node.blockId = newBlockId;
    this.cache?.set(newBlockId, node);

    // console.log("[POST] persistInternal()...", node.blockId, node.keys, node.childBlockIds)

    // console.log(`[DEBUG] Persisted internal node. oldID -> newID = ${oldBlockId} -> ${newBlockId}`);
    // console.log("we good")

    if (typeof oldBlockId === 'number' && oldBlockId !== NO_BLOCK && oldBlockId !== newBlockId) {
      this.cache?.delete(oldBlockId);
      return oldBlockId;
    }
    return undefined;
  }
  */

  /*
  // Fredje
  async persistInternal(node: FBInternalNode<Keystype, ValuesType>): Promise<number | undefined> {
    // [DEBUG]
    debug_incrementFnCallCount('persistInternal()');
    //
    const expectedChildren = node.keys.length + 1;
    if (node.childBlockIds.length < expectedChildren) {
      node.childBlockIds = node.childBlockIds.concat(
        Array(expectedChildren - node.childBlockIds.length).fill(NO_BLOCK),
      );
    } else if (node.childBlockIds.length > expectedChildren) {
      node.childBlockIds = node.childBlockIds.slice(0, expectedChildren);
    }

    if (this.inWriteSession) {
      this.captureSnapshot(node);
      const maxIndex = Math.min(node.children.length, expectedChildren);
      for (let i = 0; i < maxIndex; i++) {
        const child = node.children[i];
        if (!child) continue;
        if (child.blockId === undefined || child.blockId === NO_BLOCK) {
          await this.markNodeForPersistance(child);
        }
      }
      this.dirtyInternalNodes.add(node);
      if (node.blockId === undefined || node.blockId === NO_BLOCK) {
        this.newNodes.add(node);
      } else {
        this.cache?.set(node.blockId, node);
      }
      return undefined;
    }

    if (node.children.length > 0) {
      const maxIndex = Math.min(node.children.length, expectedChildren);
      for (let i = 0; i < maxIndex; i++) {
        const child = node.children[i];
        if (!child) continue;
        if (child.blockId === undefined || child.blockId === NO_BLOCK) {
          await this.markNodeForPersistance(child);
        }
        node.childBlockIds[i] = child.blockId as number;
      }
    }

    if (
      node.childBlockIds.length !== expectedChildren ||
      node.childBlockIds.some((id) => id === NO_BLOCK || id === undefined)
    ) {
      throw new Error('Cannot persist internal node with unpersisted children');
    }

    return this.persistInternalShallow(node);
  }
    */
  async persistInternal(node: FBInternalNode<Keystype, ValuesType>): Promise<number | undefined> {
    // [DEBUG]
    debug_incrementFnCallCount('persistInternal()');
    //

    //
    // internal node may have unpersisted leaf node children at start of persistInternal call
    //node.childBlockIds = Array(node.children.length);
    //for(let i = 0; i < node.children.length; i++){
    //  const c = node.children[i];
    //  //
    //  if(!c.isLeaf && !c.blockId){
    //    throw new Error("internal node has unpersisted internal child node(s)!");
    //  }
    //  if(!c.blockId){
    //    await this.persistLeaf(c);
    //    node.children[i] = c;
    //    const newID = c.blockId;
    //    if(newID === undefined || newID === NO_BLOCK){
    //      throw new Error("newID was undefined or NO_BLOCK");
    //    }
    //  }
    //  node.childBlockIds[i] = c.blockId;
    //  assert(node.childBlockIds[i] === node.children[i].blockId);
    //}

    //int({internal: node})
    const childCount = node.keys.length + 1;

    //
    if (this.inWriteSession) {
      this.captureSnapshot(node);
      const maxIndex = Math.min(node.children.length, childCount);
      for (let i = 0; i < maxIndex; i++) {
        const child = node.children[i];
        if (!child) continue;
        if (child.blockId === undefined || child.blockId === NO_BLOCK) {
          await this.markNodeForPersistance(child);
        }
      }
      this.dirtyInternalNodes.add(node);
      if (node.blockId === undefined || node.blockId === NO_BLOCK) {
        this.newNodes.add(node);
      } else {
        this.cache?.set(node.blockId, node);
      }
      return undefined;
    }
    //

    //
    if (node.children.length > 0) {
      const maxIndex = Math.min(node.children.length, childCount);
      for (let i = 0; i < maxIndex; i++) {
        const child = node.children[i];
        if (!child) continue;
        if (child.blockId === undefined || child.blockId === NO_BLOCK) {
          await this.markNodeForPersistance(child);
        }
        node.childBlockIds[i] = child.blockId as number;
      }
    }
    //int({internal: node})
    //

    //
    if (node.childBlockIds.some((id) => id === NO_BLOCK || id === undefined)) {
      throw new Error('Cannot persist internal node with unpersisted children');
    }
    //

    // int({internal: node})
    return this.persistInternalShallow(node);
  }

  enqueueForReclaim(blockId?: number): void {
    if (typeof blockId === 'number' && blockId !== NO_BLOCK) {
      this.reclaimQueue.add(blockId);
      // console.log('[FBNodeStorage] enqueueForReclaim: ${blockId}');
    }
  }

  async commitAndReclaim(): Promise<void> {
    await this.FBfile.commit();
    await this.reclaimQueuedBlocksNow();
    await this.FBfile.commit();
    await this.FBfile.checkpoint();
  }

  async reclaimQueuedBlocksNow(): Promise<void> {
    const ids = Array.from(this.reclaimQueue);
    if (ids.length === 0) return;
    this.reclaimQueue.clear();
    // console.log('[FBNodeStorage] reclaimQueuedBlocksNow: freeing ids: ${ids.join(',')}');
    for (const id of ids) {
      await this.freeAndDeleteCache(id);
    }
  }

  async persistNode(node: FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>): Promise<void> {
    // [DEBUG]
    debug_incrementFnCallCount('persistNode()');
    //
    if (node.isLeaf) {
      //lfs({leaf: node});
      const old = await this.persistLeaf(node);
      //lfs({leaf: node});

      if (typeof old === 'number') this.enqueueForReclaim(old);
    } else {
      // int({internal: node}); // -> fails
      const old = await this.persistInternal(node);
      //int({internal: node});

      if (typeof old === 'number') this.enqueueForReclaim(old);
    }
  }

  private async freeAndDeleteCache(blockId?: number): Promise<void> {
    if (typeof blockId !== 'number' || blockId === NO_BLOCK) return;
    try {
      await this.FBfile.freeBlob(blockId);
      // console.log('[FBNodeStorage] freeBlob called for ${blockId}');
    } catch (e) {
      console.warn(`failed to free block id ${blockId}:`, e);
    } finally {
      this.deleteCachedBlock(blockId);
    }
  }

  /**
   * Used to load the entire tree recursively.
   *
   * THIS IS NOT OPTIMIZED
   */
  async debug_recursivelyLoadTree(
    blockId: number,
  ): Promise<FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>> {
    // [DEBUG]
    debugLog(`[DEBUG] debug_recursivelyLoadTree() [${blockId}] (disk -> RAM)`);
    //

    if (blockId === NO_BLOCK || blockId === null) {
      throw new Error('Cannot load node with NO_BLOCK id');
    }

    /*
    if (this.cache?.has(blockId)) {
      // [DEBUG]
      //
      return this.cache!.get(blockId)!;
    }
      */

    const buffer = await this.FBfile.readBlob(blockId);
    if (!buffer) {
      throw new Error(`Block with id ${blockId} not found`);
    }

    const decodedPayload = this.decodeNodePayload(buffer);
    const raw = JSON.parse(decodedPayload.toString('utf-8')) as unknown;

    type LeafPayload = {
      type: 'leaf';
      keys: SerializedKey[];
      values: SerializedValue[];
      nextBlockId?: number;
      prevBlockId?: number;
      nextLeaf?: undefined;
      prevLeaf?: undefined;
    };
    type InternalPayload = {
      type: 'internal';
      keys?: SerializedKey[];
      childBlockIds?: number[];
    };

    function isLeafPayload(x: unknown): x is LeafPayload {
      if (typeof x !== 'object' || x === null) return false;
      const obj = x as Record<string, unknown>;
      return obj['type'] === 'leaf' && Array.isArray(obj['keys']) && Array.isArray(obj['values']);
    }

    function isInternalPayload(x: unknown): x is InternalPayload {
      if (typeof x !== 'object' || x === null) return false;
      const obj = x as Record<string, unknown>;
      return obj['type'] === 'internal';
    }

    if (isLeafPayload(raw)) {
      const node = new FBLeafNode<Keystype, ValuesType>(this);
      node.keys = raw.keys.map((serializedKey) => deserializeKey(serializedKey) as Keystype);
      node.values = raw.values.map((sv) => deserializeValue(sv) as ValuesType);
      node.nextBlockId =
        typeof raw.nextBlockId === 'number' && raw.nextBlockId !== NO_BLOCK ? raw.nextBlockId : undefined;
      node.prevBlockId =
        typeof raw.prevBlockId === 'number' && raw.prevBlockId !== NO_BLOCK ? raw.prevBlockId : undefined;
      node.blockId = blockId;
      //this.cache?.set(blockId, node);

      return node;
    } else if (isInternalPayload(raw)) {
      const rawInternal = raw;
      const childIds = Array.isArray(rawInternal.childBlockIds) ? rawInternal.childBlockIds.slice() : [];
      const keys = Array.isArray(rawInternal.keys) ? rawInternal.keys.map((k) => deserializeKey(k) as Keystype) : [];
      const node = new FBInternalNode<Keystype, ValuesType>(this, childIds, keys);
      node.blockId = blockId;
      node.children = [];
      //this.cache?.set(blockId, node);
      //
      for (const ID of node.childBlockIds) {
        debugLog(node.childBlockIds, ID);
        node.children.push(await this.debug_recursivelyLoadTree(ID));
      }

      // set up leaf pointers
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (!child.isLeaf) continue;
        if (i !== 0) {
          child.prevLeaf = node.children[i - 1] as FBLeafNode<Keystype, ValuesType>;
          child.prevBlockId = node.childBlockIds[i - 1];
        }
        if (i !== node.children.length - 1) {
          child.nextLeaf = node.children[i + 1] as FBLeafNode<Keystype, ValuesType>;
          child.nextBlockId = node.childBlockIds[i + 1];
        }
      }

      //
      return node;
    } else {
      throw new Error('Unknown node type in payload');
    }
  }

  /**
   * Used to load a node from disk into RAM.
   *
   * NOTE: loadNode() currently does not load the children of a node (look at type InternalPayload). I.e.,
   * - it loads childBlockIds[]
   * - but does NOT load children[]
   *
   * ~same reason why leaf nodes only keep blockIDS!
   *
   * This *is* an optimization, but the rest of the code should consider this optimization!
   */
  async loadNode(blockId: number): Promise<FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>> {
    // [DEBUG]
    debugLog(`[DEBUG] loading node [${blockId}] (disk -> RAM)`);
    //

    if (blockId === NO_BLOCK || blockId === undefined || blockId === null) {
      throw new Error('Cannot load node with NO_BLOCK id');
    }
    const cached = this.cache?.get(blockId);
    if (cached !== undefined) {
      return cached;
    }

    const buffer = await this.FBfile.readBlob(blockId);
    if (!buffer) {
      throw new Error(`Block with id ${blockId} not found`);
    }

    const decodedPayload = this.decodeNodePayload(buffer);
    const raw = JSON.parse(decodedPayload.toString('utf-8')) as unknown;

    type LeafPayload = {
      type: 'leaf';
      keys: SerializedKey[];
      values: SerializedValue[];
      nextBlockId?: number;
      prevBlockId?: number;
    };
    type InternalPayload = {
      type: 'internal';
      keys?: SerializedKey[];
      childBlockIds?: number[];
    };

    function isLeafPayload(x: unknown): x is LeafPayload {
      if (typeof x !== 'object' || x === null) return false;
      const obj = x as Record<string, unknown>;
      return obj['type'] === 'leaf' && Array.isArray(obj['keys']) && Array.isArray(obj['values']);
    }

    function isInternalPayload(x: unknown): x is InternalPayload {
      if (typeof x !== 'object' || x === null) return false;
      const obj = x as Record<string, unknown>;
      return obj['type'] === 'internal';
    }

    if (isLeafPayload(raw)) {
      const node = new FBLeafNode<Keystype, ValuesType>(this);
      node.keys = raw.keys.map((serializedKey) => deserializeKey(serializedKey) as Keystype);
      node.values = raw.values.map((sv) => deserializeValue(sv) as ValuesType);
      node.nextBlockId =
        typeof raw.nextBlockId === 'number' && raw.nextBlockId !== NO_BLOCK ? raw.nextBlockId : undefined;
      node.prevBlockId =
        typeof raw.prevBlockId === 'number' && raw.prevBlockId !== NO_BLOCK ? raw.prevBlockId : undefined;
      node.blockId = blockId;
      this.cache?.set(blockId, node);
      return node;
    } else if (isInternalPayload(raw)) {
      const rawInternal = raw;
      const childIds = Array.isArray(rawInternal.childBlockIds) ? rawInternal.childBlockIds.slice() : [];
      const keys = Array.isArray(rawInternal.keys) ? rawInternal.keys.map((k) => deserializeKey(k) as Keystype) : [];
      const node = new FBInternalNode<Keystype, ValuesType>(this, childIds, keys);
      node.blockId = blockId;
      node.children = [];
      this.cache?.set(blockId, node);
      return node;
    } else {
      throw new Error('Unknown node type in payload');
    }
  }

  debug_clearCache(): void {
    this.cache?.clear();
  }

  deleteCachedBlock(blockId?: number): void {
    if (typeof blockId === 'number' && blockId !== NO_BLOCK) {
      this.cache?.delete(blockId);
    }
  }
}

/**
 * FBNodeBase is the base class for FBLeafNode and FBInternalNode.
 *
 * @template Keystype - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 */
export class FBNodeBase<Keystype, ValuesType>
  implements
    NodeBaseStorage<Keystype, ValuesType, FBLeafNode<Keystype, ValuesType>, FBInternalNode<Keystype, ValuesType>>
{
  readonly isLeaf!: boolean;

  constructor(protected storage: FBNodeStorage<Keystype, ValuesType>) {}

  public getStorage(): FBNodeStorage<Keystype, ValuesType> {
    return this.storage;
  }

  canMergeWithNext(
    _key: Keystype,
    _nextNode: FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>,
  ): boolean {
    return false;
  }

  async mergeWithNext(
    _key: Keystype,
    _nextNode: FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>,
  ): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * FBLeafNode is the implementation of a leaf node in the FBNodeStorage.
 *
 * @template Keystype - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 */
export class FBLeafNode<Keystype, ValuesType>
  implements
    LeafNodeStorage<Keystype, ValuesType, FBLeafNode<Keystype, ValuesType>, FBInternalNode<Keystype, ValuesType>>
{
  readonly isLeaf = true;

  keys: Keystype[] = [];
  values: ValuesType[] = [];
  nextBlockId?: number;
  prevBlockId?: number;
  nextLeaf: FBLeafNode<Keystype, ValuesType> | null = null;
  prevLeaf: FBLeafNode<Keystype, ValuesType> | null = null;

  blockId?: number;

  constructor(private storage: FBNodeStorage<Keystype, ValuesType>) {}

  getStorage(): FBNodeStorage<Keystype, ValuesType> {
    return this.storage;
  }

  getCursorBeforeFirst(): LeafCursor<
    Keystype,
    ValuesType,
    FBLeafNode<Keystype, ValuesType>,
    FBInternalNode<Keystype, ValuesType>
  > {
    return new FBLeafCursor<Keystype, ValuesType>(this, -1);
  }

  getLowerBoundIndex(key: Keystype): number {
    return lowerBound(this.keys, key, this.storage.compareKeys);
  }

  getCursorBeforeKey(key: Keystype): {
    cursor: LeafCursor<Keystype, ValuesType, FBLeafNode<Keystype, ValuesType>, FBInternalNode<Keystype, ValuesType>>;
    isAtKey: boolean;
  } {
    const index = this.getLowerBoundIndex(key);
    const cursor = new FBLeafCursor<Keystype, ValuesType>(this, index - 1);
    const isAtKey = index < this.keys.length && this.storage.compareKeys(this.keys[index], key) === 0;
    return { cursor, isAtKey };
  }

  async getNextLeaf(): Promise<FBLeafNode<Keystype, ValuesType> | null> {
    if (this.nextLeaf) return this.nextLeaf;
    if (this.nextBlockId === undefined || this.nextBlockId === NO_BLOCK) return null;
    const nextLeaf = await this.storage.loadNode(this.nextBlockId);
    if (!nextLeaf.isLeaf) throw new Error('Next leaf node is not a leaf');
    this.nextLeaf = nextLeaf;
    if (this.nextLeaf) {
      this.nextLeaf.prevLeaf = this;
      this.nextLeaf.prevBlockId = this.blockId;
    }
    return this.nextLeaf;
  }

  async getPrevLeaf(): Promise<FBLeafNode<Keystype, ValuesType> | null> {
    if (this.prevLeaf) return this.prevLeaf;
    if (this.prevBlockId === undefined || this.prevBlockId === NO_BLOCK) return null;
    const prevLeaf = await this.storage.loadNode(this.prevBlockId);
    if (!prevLeaf.isLeaf) throw new Error('Previous leaf node is not a leaf');
    this.prevLeaf = prevLeaf;
    if (this.prevLeaf) {
      this.prevLeaf.nextLeaf = this;
      this.prevLeaf.nextBlockId = this.blockId;
    }
    return this.prevLeaf;
  }

  canMergeWithNext(
    _key: Keystype,
    nextNode: FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>,
  ): boolean {
    if (!nextNode.isLeaf) return false;
    const totalKeys = this.keys.length + (nextNode.keys ? nextNode.keys.length : 0);
    return totalKeys <= this.storage.getMaxKeySize();
  }

  async mergeWithNext(
    _key: Keystype,
    nextNode: FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>,
  ): Promise<void> {
    if (!nextNode.isLeaf) {
      throw new Error('Cannot merge with non-leaf node');
    }

    //
    //lfs({leaf: this});
    //lfs({leaf: nextNode});
    //

    const nextLeaf = nextNode;
    this.keys.push(...nextLeaf.keys);
    this.values.push(...nextLeaf.values);
    this.nextBlockId = nextLeaf.nextBlockId ?? NO_BLOCK;
    this.nextLeaf = nextLeaf.nextLeaf ?? null;

    //lfs({leaf: this});
    //lfs({leaf: nextNode});

    const mergedOld = await this.getStorage().persistLeaf(this);
    if (typeof mergedOld === 'number') this.getStorage().enqueueForReclaim(mergedOld);

    //lfs({leaf: this});
    //lfs({leaf: nextNode});

    if (this.nextLeaf) {
      this.nextLeaf.prevBlockId = this.blockId;
      this.nextLeaf.prevLeaf = this;

      //lfs({leaf: this});
      //lfs({leaf: nextNode});

      const succOld = await this.getStorage().persistLeaf(this.nextLeaf);
      if (typeof succOld === 'number') this.getStorage().enqueueForReclaim(succOld);

      //lfs({leaf: this});
      //lfs({leaf: nextNode});
    }

    if (typeof nextLeaf.blockId === 'number' && nextLeaf.blockId !== NO_BLOCK) {
      this.getStorage().enqueueForReclaim(nextLeaf.blockId);
    }

    //lfs({leaf: this});
    //lfs({leaf: nextNode});
  }
}

/**
 * FBLeafCursor is the implementation of a leaf cursor for FBLeafNode.
 *
 * @template Keystype - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 */
export class FBLeafCursor<Keystype, ValuesType>
  implements LeafCursor<Keystype, ValuesType, FBLeafNode<Keystype, ValuesType>, FBInternalNode<Keystype, ValuesType>>
{
  private position: number;

  constructor(
    public readonly leaf: FBLeafNode<Keystype, ValuesType>,
    position: number = -1,
  ) {
    this.position = position;
  }

  reset(): void {
    this.position = -1;
  }

  isAfterLast(): boolean {
    return this.position + 1 >= this.leaf.keys.length;
  }

  getKeyValuePairAfter(): { key: Keystype; value: ValuesType } {
    const nextIndex = this.position + 1;
    if (nextIndex < 0 || nextIndex >= this.leaf.keys.length) {
      throw new Error('No key/value pair after cursor');
    }
    return { key: this.leaf.keys[nextIndex], value: this.leaf.values[nextIndex] };
  }

  moveNext(): void {
    this.position++;
  }

  movePrev(): void {
    this.position--;
  }

  async insert(
    key: Keystype,
    value: ValuesType,
  ): Promise<{ nodes: FBLeafNode<Keystype, ValuesType>[]; keys: Keystype[] }> {
    // Capture snapshot BEFORE mutating
    this.leaf.getStorage().captureSnapshot(this.leaf);
    const insertPosition = lowerBound(this.leaf.keys, key, this.leaf.getStorage().compareKeys);
    this.leaf.keys.splice(insertPosition, 0, key);
    this.leaf.values.splice(insertPosition, 0, value);

    const old = await this.leaf.getStorage().persistLeaf(this.leaf);
    if (typeof old === 'number') this.leaf.getStorage().enqueueForReclaim(old);

    return { nodes: [this.leaf], keys: this.leaf.keys.slice() };
  }

  async removeKeyValuePairAfter(): Promise<void> {
    // Capture snapshot BEFORE mutating
    this.leaf.getStorage().captureSnapshot(this.leaf);
    const removeIndex = this.position + 1;
    if (removeIndex < 0 || removeIndex >= this.leaf.keys.length) {
      throw new Error('No key/value pair to remove after cursor');
    }
    this.leaf.keys.splice(removeIndex, 1);
    this.leaf.values.splice(removeIndex, 1);

    const old = await this.leaf.getStorage().persistLeaf(this.leaf);
    if (typeof old === 'number') this.leaf.getStorage().enqueueForReclaim(old);
  }
}

/**
 * FBInternalNode is the implementation of an internal node in the FBNodeStorage.
 *
 * @template Keystype - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 */
export class FBInternalNode<Keystype, ValuesType>
  implements
    InternalNodeStorage<Keystype, ValuesType, FBLeafNode<Keystype, ValuesType>, FBInternalNode<Keystype, ValuesType>>
{
  readonly isLeaf = false;

  keys: Keystype[] = [];
  childBlockIds: number[] = [];
  children: (FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>)[] = [];
  blockId?: number;

  constructor(
    private storage: FBNodeStorage<Keystype, ValuesType>,
    childBlockIds: number[] = [],
    keys: Keystype[] = [],
  ) {
    this.childBlockIds = childBlockIds.slice();
    this.keys = keys.slice();
  }

  getStorage(): FBNodeStorage<Keystype, ValuesType> {
    return this.storage;
  }

  async getChildCursorAtFirstChild(): Promise<
    ChildCursor<Keystype, ValuesType, FBLeafNode<Keystype, ValuesType>, FBInternalNode<Keystype, ValuesType>>
  > {
    const child = new FBChildCursor<Keystype, ValuesType>(this);
    child.setPosition(0);
    return Promise.resolve(child);
  }

  getChildCursorAtKey(key: Keystype): Promise<{
    cursor: ChildCursor<Keystype, ValuesType, FBLeafNode<Keystype, ValuesType>, FBInternalNode<Keystype, ValuesType>>;
    isAtKey: boolean;
  }> {
    const index = upperBound(this.keys, key, this.storage.compareKeys);
    const cursor = new FBChildCursor<Keystype, ValuesType>(this);
    cursor.setPosition(index);
    const isAtKey = index > 0 && this.storage.compareKeys(key, this.keys[index - 1]) === 0;
    return Promise.resolve({ cursor, isAtKey });
  }

  isUnderfull(): boolean {
    const minKeys = Math.floor(this.storage.getMaxKeySize() / 2);
    return this.keys.length < minKeys;
  }

  async deallocateUnderfull(): Promise<FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>> {
    return Promise.resolve(this);
  }

  async moveLastChildTo(separatorKey: Keystype, nextNode: FBInternalNode<Keystype, ValuesType>): Promise<Keystype> {
    //
    //int({internal: this});
    //int({internal: nextNode});

    /**
     * A = this
     * B = nextNode
     *
     * A.children -> [1,2,3,4]
     * B.children -> [5,6]
     *
     * A' -> [1,2,3]
     * B' -> [4,5,6]
     *
     * Move 3 things: key, childblockid, child
     */
    //

    const lastKey = this.keys.pop()!;
    nextNode.keys.unshift(separatorKey);

    const lastChildBlockId = this.childBlockIds.pop()!;
    nextNode.childBlockIds.unshift(lastChildBlockId);

    const lastChild = this.children.pop()!;
    nextNode.children.unshift(lastChild);
    //
    const oldThis = await this.storage.persistInternal(this);
    if (typeof oldThis === 'number') this.storage.enqueueForReclaim(oldThis);
    const oldNext = await this.storage.persistInternal(nextNode);
    if (typeof oldNext === 'number') this.storage.enqueueForReclaim(oldNext);

    //int({internal: this});
    //int({internal: nextNode});

    return lastKey;
  }

  async moveFirstChildTo(
    previousNode: FBInternalNode<Keystype, ValuesType>,
    separatorKey: Keystype,
  ): Promise<Keystype> {
    /**
     * A = this
     * B = previousNode
     *
     * A.children -> [1,2,3]
     * B.children -> [4,5]
     *
     * A' -> [2,3]
     * B' -> [4,5,1]
     *
     * Move 3 things: key, childblockid, child
     */
    //

    //
    //int({internal: this});
    //int({internal: previousNode});

    //
    const firstKey = this.keys.shift()!;
    previousNode.keys.push(separatorKey);

    const firstChildBlockId = this.childBlockIds.shift()!;
    previousNode.childBlockIds.push(firstChildBlockId);

    const firstChild = this.children.shift()!;
    previousNode.children.push(firstChild);
    //

    const oldThis = await this.storage.persistInternal(this);
    if (typeof oldThis === 'number') this.storage.enqueueForReclaim(oldThis);
    const oldPrev = await this.storage.persistInternal(previousNode);
    if (typeof oldPrev === 'number') this.storage.enqueueForReclaim(oldPrev);

    //int({internal: this});
    //int({internal: previousNode});

    return firstKey;
  }

  canMergeWithNext(
    _key: Keystype,
    nextNode: FBInternalNode<Keystype, ValuesType> | FBLeafNode<Keystype, ValuesType>,
  ): boolean {
    if (nextNode.isLeaf) return false;
    const totalKeys = this.keys.length + nextNode.keys.length;
    return totalKeys <= this.storage.getMaxKeySize();
  }

  async mergeWithNext(
    _key: Keystype,
    nextNode: FBInternalNode<Keystype, ValuesType> | FBLeafNode<Keystype, ValuesType>,
  ): Promise<void> {
    if (nextNode.isLeaf) {
      throw new Error('Cannot merge with non-internal node');
    }
    //
    const nextInternal = nextNode;
    //int({internal: this});
    //int({internal: nextInternal});
    //

    //
    this.keys.push(_key, ...nextInternal.keys);
    this.childBlockIds.push(...nextInternal.childBlockIds);
    this.children.push(...nextInternal.children);

    // // no.
    // if (this.hasFullyMaterializedChildren() && nextInternal.hasFullyMaterializedChildren()) {
    //   this.childBlockIds.push(...nextInternal.childBlockIds);
    // } else {
    //   this.clearChildrenCache();
    // }

    // so A=`this` remains. The nextInternal B dissapears. A, B -> AB = A'

    const oldThis = await this.getStorage().persistInternal(this);
    if (typeof oldThis === 'number') this.getStorage().enqueueForReclaim(oldThis);

    if (typeof nextInternal.blockId === 'number' && nextInternal.blockId !== NO_BLOCK) {
      this.getStorage().enqueueForReclaim(nextInternal.blockId);
    }
  }
}

/**
 * FBChildCursor is the implementation of a child cursor for FBInternalNode.
 *
 * @template Keystype - The type of keys used in the nodes.
 * @template ValuesType - The type of values stored in the leaf nodes.
 */
export class FBChildCursor<Keystype, ValuesType>
  implements ChildCursor<Keystype, ValuesType, FBLeafNode<Keystype, ValuesType>, FBInternalNode<Keystype, ValuesType>>
{
  private position: number = 0;

  constructor(public readonly parent: FBInternalNode<Keystype, ValuesType>) {}

  setPosition(pos: number): void {
    this.position = pos;
  }

  reset(): void {
    this.position = 0;
  }

  isFirstChild(): boolean {
    return this.position === 0;
  }

  isLastChild(): boolean {
    return this.position === this.parent.childBlockIds.length - 1;
  }

  async getChild(offset: number = 0): Promise<FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>> {
    const targetPosition = this.position + offset;
    const maxChildren = Math.max(this.parent.childBlockIds.length, this.parent.children.length);
    if (targetPosition < 0 || targetPosition >= maxChildren) {
      console.log(targetPosition, maxChildren);
      throw new Error('Child cursor out of bounds');
    }

    const maybeChild = this.parent.children && this.parent.children[targetPosition];
    if (maybeChild) {
      return maybeChild;
    }

    const blockId = this.parent.childBlockIds[targetPosition];
    if (blockId === NO_BLOCK || blockId === undefined || blockId === null) {
      const kidsBlockIds = JSON.stringify(this.parent.childBlockIds);
      const kidsInMemory = JSON.stringify((this.parent.children || []).map((c) => (c ? (c.blockId ?? null) : null)));
      throw new Error(
        `Child absent at position ${targetPosition}: blockId=${String(blockId)}; parent.keys=${JSON.stringify(
          this.parent.keys,
        )}; childBlockIds=${kidsBlockIds}; children.blockIds=${kidsInMemory}`,
      );
    }

    const childNode = await this.parent.getStorage().loadNode(blockId);
    this.parent.children[targetPosition] = childNode;
    return childNode;
  }

  getKeyAfter(): Keystype {
    if (this.position < 0 || this.position >= this.parent.keys.length) {
      throw new Error('No key after for this child position');
    }
    return this.parent.keys[this.position];
  }

  moveNext(): void {
    this.position++;
  }

  movePrev(): void {
    this.position--;
  }

  async replaceKeysAndChildrenAfterBy(
    count: number,
    replacementKeys: Keystype[],
    replacementChildren: (FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>)[],
  ): Promise<{ nodes: (FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType>)[]; keys: Keystype[] }> {
    const replacementIds: number[] = [];

    for (const child of replacementChildren) {
      if (child.blockId === undefined || child.blockId === NO_BLOCK) {
        if (child.isLeaf) {
          const old = await this.parent.getStorage().persistLeaf(child);
          if (typeof old === 'number') this.parent.getStorage().enqueueForReclaim(old);
        } else {
          const old = await this.parent.getStorage().persistInternal(child);
          if (typeof old === 'number') this.parent.getStorage().enqueueForReclaim(old);
        }
      }
      replacementIds.push(child.blockId as number);
    }

    this.parent.keys.splice(this.position, count, ...replacementKeys);
    this.parent.childBlockIds.splice(this.position, count + 1, ...replacementIds);
    this.parent.children.splice(this.position, count + 1, ...replacementChildren);

    const parentOld = await this.parent.getStorage().persistInternal(this.parent);
    if (typeof parentOld === 'number') this.parent.getStorage().enqueueForReclaim(parentOld);

    const storage = this.parent.getStorage();
    if (!storage.isInWriteSession()) {
      await storage.reclaimQueuedBlocksNow();
    }

    const nodes = this.parent.children.filter(
      (node): node is FBLeafNode<Keystype, ValuesType> | FBInternalNode<Keystype, ValuesType> => node !== undefined,
    );
    return { nodes, keys: this.parent.keys.slice() };
  }
}
