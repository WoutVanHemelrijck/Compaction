// @author MaartenHaine, Jari Daemen, Frederick Hillen
// used Claude for debugging
// @date 2026-04-16

import { BPlusTree } from '../indexes/b-plus-tree.mjs';
import { FBNodeStorage, FBLeafNode, FBInternalNode } from '../storage/node-storage/fb-node-storage.mjs';
import { FreeBlockFile, DEFAULT_BLOCK_SIZE, NO_BLOCK } from '../storage/freeblockfile.mjs';
import { AtomicFileImpl } from '../durability/atomic-operations/atomic-file.mjs';
import { WALManagerImpl } from '../durability/atomic-operations/wal-manager.mjs';
import { type File } from '../storage/file/file.mjs';
import type { DiskBackedIndexStorage } from '../big-data-import/disk-backed-index-builder.mjs';
import { randomUUID } from 'crypto';
import {
  CompressionService,
  resolveCompressionAlgorithmFromEnvironment,
} from '../durability/compression/compression.mjs';
import { deserializeCompressionEnvelope, serializeCompressionEnvelope } from '../durability/compression/envelope.mjs';
import { hnswIndexImpl } from '../../nlp/text-embedding/hnsw-index.mjs';
import { debugLog, isDebugEnabled, debug_incrementFnCallCount } from './debug-global-constants.mjs';
// import { debug_checkInvariants, debug_treeStats } from './invariants.mjs';
import type { IndexEntry } from '../big-data-import/disk-backed-index-builder.mjs';

import { Interpreter, NaturalLanguageExecutor } from '../../query-language/index.mjs';

import { SimpleDBMSStorageAdapter } from '../../query-language/storage-adapter/simpledbms-storage-adapter.mjs';

const HEADER_COMPRESSED_PAYLOAD_MAGIC = Buffer.from('DBH1', 'ascii');
const headerCompressionService = new CompressionService({ algorithm: resolveCompressionAlgorithmFromEnvironment() });
const DEFAULT_SECONDARY_INDEX_ORDER = 50;

// Helper to trigger GC if available
function requestGarbageCollection(): void {
  if (typeof global.gc === 'function') {
    global.gc();
  }
}

function encodeHeaderForStorage(header: Record<string, unknown>): Buffer {
  const jsonBuffer = Buffer.from(JSON.stringify(header));
  const compressed = headerCompressionService.compress(jsonBuffer);

  if (compressed.compressedSize >= compressed.originalSize) {
    return jsonBuffer;
  }

  return serializeCompressionEnvelope(HEADER_COMPRESSED_PAYLOAD_MAGIC, compressed);
}

function decodeHeaderFromStorage(payload: Buffer): string {
  const compressed = deserializeCompressionEnvelope(payload, HEADER_COMPRESSED_PAYLOAD_MAGIC);
  if (compressed === null) {
    return payload.toString();
  }

  return headerCompressionService.decompress(compressed).toString();
}

// Document interface
// shows all valid data types for the document
export type DocumentValue =
  | string
  | number
  | boolean
  | null
  | bigint
  | DocumentValue[]
  | { [key: string]: DocumentValue };

// Gives a documetn its own id. It is an interface that can be easily given as input
// and as interface to implemented.
export interface Document {
  id: string;
  [key: string]: DocumentValue;
}

// Filter operators interface
export interface FilterOperators {
  [field: string]: {
    $eq?: DocumentValue;
    $ne?: DocumentValue;
    $gt?: DocumentValue;
    $gte?: DocumentValue;
    $lt?: DocumentValue;
    $lte?: DocumentValue;
    $in?: DocumentValue[];
    $nin?: DocumentValue[];
    $includes?: string;
  };
}

// Aggregation query interface
export interface AggregateQuery {
  groupBy: string;
  operations: {
    count?: string;
    sum?: { field: string; as: string }[];
    avg?: { field: string; as: string }[];
    min?: { field: string; as: string }[];
    max?: { field: string; as: string }[];
  };
}

// Join query interface
export interface JoinQuery {
  collection: string;
  on: string;
  rightOn?: string;
}

// Query options interface
export interface Query {
  filter?: (doc: Document) => boolean;
  filterOps?: FilterOperators;
  sort?: { field: string; order: 'asc' | 'desc' };
  skip?: number;
  limit?: number;
  idRange?: { min?: string; max?: string };
  projection?: string[];
  aggregate?: AggregateQuery;
  join?: JoinQuery;
}

/**
 * Serializes a field value for use as a B+ Tree key.
 * Ensures proper ordering: numbers, strings, booleans, null, bigint.
 *
 * @param {unknown} value The value to serialize
 * @returns {string} A string representation that maintains sort order
 */
export function serializeFieldValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';

  if (typeof value === 'boolean') {
    return value ? 'boolT' : 'boolF';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      if (Number.isNaN(value)) return 'num:NaN';
      return value === Infinity ? 'num:+Inf' : 'num:-Inf';
    }
    const sign = value < 0 ? '-' : '+';
    const abs = Math.abs(value);
    const intPart = Math.floor(abs).toString().padStart(16, '0');
    const fracPart = Math.round((abs - Math.floor(abs)) * 1e8)
      .toString()
      .padStart(8, '0');
    return `num:${sign}${intPart}.${fracPart}`;
  }

  if (typeof value === 'bigint') {
    const sign = value < 0n ? '-' : '+';
    const abs = value < 0n ? -value : value;
    return `bigint:${sign}${abs.toString().padStart(20, '0')}`;
  }

  // Default to string
  if (typeof value === 'object' && value !== null) {
    return `str:${JSON.stringify(value)}`;
  }
  if (value === undefined) {
    return 'str:undefined';
  }
  // For primitive types, convert to string
  return `str:${value as string | number | boolean | bigint}`;
}

/**
 * Deserializes a field value from its B+ Tree key representation.
 *
 * @param {string} serialized The serialized string
 * @returns {DocumentValue} The original value
 */
export function deserializeFieldValue(serialized: string): DocumentValue {
  if (serialized === '' || serialized === 'null') return null;

  if (serialized.startsWith('bool')) {
    return serialized === 'boolT';
  }

  if (serialized.startsWith('num:')) {
    const body = serialized.substring(4);
    if (body === 'NaN') return NaN;
    if (body === '+Inf') return Infinity;
    if (body === '-Inf') return -Infinity;

    const sign = body[0];
    const rest = body.substring(1);
    const [intPart, fracPart = '0'] = rest.split('.');
    const num = Number((sign === '-' ? '-' : '') + Number(intPart) + '.' + (fracPart || '0'));
    return num;
  }

  if (serialized.startsWith('bigint:')) {
    try {
      const body = serialized.substring(7);
      const sign = body[0];
      const rest = body.substring(1);
      const value = BigInt(rest);
      return sign === '-' ? -value : value;
    } catch {
      return null;
    }
  }

  if (serialized.startsWith('str:')) {
    const strValue = serialized.substring(4);
    try {
      const parsed: unknown = JSON.parse(strValue);
      // Check if it was originally an object/array
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as DocumentValue;
      }
    } catch {
      // Not a JSON string, return as is
    }
    return strValue;
  }

  return serialized;
}

/**
 * Helper: check if field is indexable
 * @param {string} fieldName The field name to check
 * @returns {boolean} True if the field is indexable
 */
export function isIndexableField(fieldName: string): boolean {
  return !fieldName.startsWith('_') && fieldName !== 'id' && fieldName !== 'content';
}

// Collection class with secondary index support
export class Collection {
  private documentHeap: FreeBlockFile;

  // Indexes: field name -> B+ Tree
  // The 'id' index is guaranteed to exist and serves as the primary index
  private indexes: Map<string, BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>> =
    new Map();

  private onChangeCallback?: () => Promise<void>;
  private createIndexStorage?: () => FBNodeStorage<string, number>;
  private onIndexCreated?: (indexes: Array<{ fieldName: string; rootBlockId: number }>) => Promise<void>;
  private onIndexDropped?: (fieldName: string) => Promise<void>;
  private onDocumentCountChanged?: (documentCount: number) => Promise<void>;
  private onIndexTreesCommitted?: () => Promise<void>;
  private cachedDocumentCount: number | null = null;
  private hnswIndex: hnswIndexImpl | undefined;
  private secondaryIndexOrder: number;
  private autoCreateSecondaryIndexesOnInsert = true;
  private pendingDeferredIndexFields = new Set<string>();
  private firstCountDoc = true;

  constructor(
    documentHeap: FreeBlockFile,
    primaryIndexTree: BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>,
    onChangeCallback?: () => Promise<void>,
    createIndexStorage?: () => FBNodeStorage<string, number>,
    onIndexCreated?: (indexes: Array<{ fieldName: string; rootBlockId: number }>) => Promise<void>,
    onDocumentCountChanged?: (documentCount: number) => Promise<void>,
    onIndexTreesCommitted?: () => Promise<void>,
    initialDocumentCount?: number,
    secondaryIndexOrder: number = DEFAULT_SECONDARY_INDEX_ORDER,
    onIndexDropped?: (fieldName: string) => Promise<void>,
    hnswIndex?: hnswIndexImpl,
  ) {
    this.documentHeap = documentHeap;
    this.indexes.set('id', primaryIndexTree);
    this.onChangeCallback = onChangeCallback;
    this.createIndexStorage = createIndexStorage;
    this.onIndexCreated = onIndexCreated;
    this.onIndexDropped = onIndexDropped;
    this.onDocumentCountChanged = onDocumentCountChanged;
    this.onIndexTreesCommitted = onIndexTreesCommitted;
    this.cachedDocumentCount = initialDocumentCount ?? null;
    this.hnswIndex = hnswIndex;
    this.secondaryIndexOrder = secondaryIndexOrder;
  }

  /**
   * Creates a secondary index on a field.
   * @param {string} fieldName The field to index
   * @param {FBNodeStorage<string, number>} storage The storage to use for the index B+ Tree
   * @throws {Error} If the field is not indexable (starts with _ or is 'id')
   * @returns {Promise<void>} A promise that resolves when the index is created
   */
  async createIndex(
    fieldName: string,
    storage: FBNodeStorage<string, number>,
  ): Promise<{
    fieldName: string;
    indexTree: BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>;
    storage: FBNodeStorage<string, number>;
  }> {
    if (!isIndexableField(fieldName)) {
      throw new Error(`Field ${fieldName} cannot be indexed (starts with _ or is 'id')`);
    }

    if (this.indexes.has(fieldName)) {
      throw new Error(`Index already exists for field: ${fieldName}`);
    }

    const indexTree = new BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>(
      storage,
      this.secondaryIndexOrder,
    );
    await indexTree.init();

    indexTree.beginTransaction();

    try {
      const sortedEntries = await this.collectSortedIndexEntries(fieldName);
      const root = await this.buildIndexTreeBottomUp(indexTree, sortedEntries, this.secondaryIndexOrder);
      if (root !== null) {
        indexTree.load(root);
      }

      await indexTree.commitTransaction();
      if (this.onIndexTreesCommitted) {
        await this.onIndexTreesCommitted();
      }
    } catch (error) {
      indexTree.abortTransaction();
      throw error;
    }

    this.indexes.set(fieldName, indexTree);
    return { fieldName, indexTree, storage };
  }

  private async collectSortedIndexEntries(fieldName: string): Promise<Array<{ key: string; value: number }>> {
    const primaryTree = this.indexes.get('id')!;
    const entries: Array<{ key: string; value: number }> = [];

    for await (const { key: docId, value: startBlockId } of primaryTree.entries()) {
      const docBuffer = await this.documentHeap.readBlob(startBlockId);
      if (docBuffer.length === 0) {
        continue;
      }

      const doc = JSON.parse(docBuffer.toString()) as Document;
      const fieldValue = doc[fieldName];
      if (fieldValue === undefined || fieldValue === null) {
        continue;
      }

      entries.push({
        key: serializeFieldValue(fieldValue) + ':' + docId,
        value: startBlockId,
      });
    }

    entries.sort((a, b) => {
      if (a.key < b.key) return -1;
      if (a.key > b.key) return 1;
      return a.value - b.value;
    });

    return entries;
  }

  private async buildIndexTreeBottomUp(
    indexTree: BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>,
    sortedEntries: Array<{ key: string; value: number }>,
    order: number,
  ): Promise<FBLeafNode<string, number> | FBInternalNode<string, number> | null> {
    if (sortedEntries.length === 0) {
      return null;
    }

    const storage = indexTree.getStorage();
    const leafNodes: FBLeafNode<string, number>[] = [];

    for (let i = 0; i < sortedEntries.length; i += order) {
      const chunk = sortedEntries.slice(i, i + order);
      const leaf = await storage.createLeaf();
      leaf.keys = chunk.map((entry) => entry.key);
      leaf.values = chunk.map((entry) => entry.value);
      leafNodes.push(leaf);
    }

    for (let i = 0; i < leafNodes.length; i++) {
      const prev = i > 0 ? leafNodes[i - 1] : null;
      const next = i + 1 < leafNodes.length ? leafNodes[i + 1] : null;
      leafNodes[i].prevLeaf = prev;
      leafNodes[i].nextLeaf = next;
    }

    for (const leaf of leafNodes) {
      await storage.persistNode(leaf);
    }

    type LevelNode = {
      node: FBLeafNode<string, number> | FBInternalNode<string, number>;
      minKey: string;
    };

    let currentLevel: LevelNode[] = leafNodes.map((leaf) => ({
      node: leaf,
      minKey: leaf.keys[0],
    }));

    const maxChildren = order + 1;
    while (currentLevel.length > 1) {
      const nextLevel: LevelNode[] = [];

      for (let i = 0; i < currentLevel.length; i += maxChildren) {
        const group = currentLevel.slice(i, i + maxChildren);
        const children = group.map((entry) => entry.node);
        const keys = group.slice(1).map((entry) => entry.minKey);

        const internal = await storage.createInternalNode(children, keys);
        await storage.persistNode(internal);

        nextLevel.push({
          node: internal,
          minKey: group[0].minKey,
        });
      }

      currentLevel = nextLevel;
    }

    return currentLevel[0].node;
  }

  private async *resolveSortedEntries(
    sortedEntries: AsyncIterable<IndexEntry>,
    primaryTree: BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>,
  ): AsyncGenerator<{ key: string; value: number }, void, unknown> {
    for await (const entry of sortedEntries) {
      if (typeof entry.directBlockId === 'number') {
        yield { key: entry.key, value: entry.directBlockId };
        continue;
      }

      const colonIndex = entry.key.lastIndexOf(':');
      if (colonIndex === -1) {
        continue;
      }

      const docId = entry.key.substring(colonIndex + 1);
      const startBlockId = await primaryTree.search(docId);
      if (startBlockId !== null) {
        yield { key: entry.key, value: startBlockId };
      }
    }
  }

  private async buildIndexTreeBottomUpFromEntries(
    indexTree: BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>,
    entries: AsyncIterable<{ key: string; value: number }>,
    order: number,
  ): Promise<FBLeafNode<string, number> | FBInternalNode<string, number> | null> {
    const storage = indexTree.getStorage();
    let chunk: Array<{ key: string; value: number }> = [];
    let previousLeaf: FBLeafNode<string, number> | null = null;

    type LevelNode = {
      node: FBLeafNode<string, number> | FBInternalNode<string, number>;
      minKey: string;
    };

    const maxChildren = order + 1;
    const levelQueues: LevelNode[][] = [];

    const pushLevelNode = async (level: number, levelNode: LevelNode): Promise<void> => {
      if (levelQueues[level] === undefined) {
        levelQueues[level] = [];
      }

      levelQueues[level].push(levelNode);

      if (levelQueues[level].length >= maxChildren) {
        const group = levelQueues[level].splice(0, maxChildren);
        const children = group.map((entry) => entry.node);
        const keys = group.slice(1).map((entry) => entry.minKey);

        const internal = await storage.createInternalNode(children, keys);
        await storage.persistNode(internal);

        await pushLevelNode(level + 1, {
          node: internal,
          minKey: group[0].minKey,
        });
      }
    };

    const flushLeafChunk = async (leafChunk: Array<{ key: string; value: number }>): Promise<void> => {
      const leaf = await storage.createLeaf();
      leaf.keys = leafChunk.map((item) => item.key);
      leaf.values = leafChunk.map((item) => item.value);

      if (previousLeaf !== null) {
        previousLeaf.nextLeaf = leaf;
        leaf.prevLeaf = previousLeaf;
        await storage.persistNode(previousLeaf);
      }

      previousLeaf = leaf;
      await pushLevelNode(0, {
        node: leaf,
        minKey: leaf.keys[0],
      });
    };

    for await (const entry of entries) {
      chunk.push(entry);
      if (chunk.length >= order) {
        await flushLeafChunk(chunk);
        chunk = [];
      }
    }

    if (chunk.length > 0) {
      await flushLeafChunk(chunk);
    }

    if (previousLeaf === null) {
      return null;
    }

    // Persist the final leaf that has no successor.
    await storage.persistNode(previousLeaf);

    // Flush remaining queued nodes from each level upward.
    for (let level = 0; level < levelQueues.length; level++) {
      const queue = levelQueues[level];
      if (queue === undefined) {
        continue;
      }

      while (queue.length > 1) {
        const groupSize = Math.min(maxChildren, queue.length);
        const group = queue.splice(0, groupSize);
        const children = group.map((entry) => entry.node);
        const keys = group.slice(1).map((entry) => entry.minKey);

        const internal = await storage.createInternalNode(children, keys);
        await storage.persistNode(internal);

        await pushLevelNode(level + 1, {
          node: internal,
          minKey: group[0].minKey,
        });
      }

      if (
        queue.length === 1 &&
        level + 1 < levelQueues.length &&
        levelQueues[level + 1] !== undefined &&
        levelQueues[level + 1].length > 0
      ) {
        const single = queue.shift() as LevelNode;
        await pushLevelNode(level + 1, single);
      }
    }

    for (let level = levelQueues.length - 1; level >= 0; level--) {
      const queue = levelQueues[level];
      if (queue !== undefined && queue.length > 0) {
        return queue[0].node;
      }
    }

    return null;
  }

  /**
   * Drops a secondary index.
   * @param {string} fieldName The field to drop the index for
   * @returns {Promise<void>} A promise that resolves when the index is dropped
   */
  async dropIndex(fieldName: string): Promise<void> {
    if (fieldName === 'id') {
      throw new Error('Cannot drop the primary ID index');
    }
    if (!this.indexes.has(fieldName)) {
      throw new Error(`Index does not exist for field: ${fieldName}`);
    }
    this.indexes.delete(fieldName);

    // Remove the index metadata from persistent storage
    if (this.onIndexDropped) {
      await this.onIndexDropped(fieldName);
    }

    // checking if this had the method onChangeCallback
    if (this.onChangeCallback) {
      await this.onChangeCallback();
    }
  }

  /**
   * Gets the Document Heap
   */
  getDocumentHeap() {
    return this.documentHeap;
  }

  /**
   * Returns every document ID paired with the block ID where its blob starts
   * on the heap.  Used by inspection and demo tooling.
   */
  async getDocumentBlockIds(): Promise<Array<{ docId: string; startBlockId: number }>> {
    const result: Array<{ docId: string; startBlockId: number }> = [];
    const primaryTree = this.indexes.get('id')!;
    for await (const { key: docId, value: startBlockId } of primaryTree.entries()) {
      result.push({ docId, startBlockId });
    }
    return result;
  }

  /**
   * Iterates over all documents in the collection as key-value pairs.
   */
  async *entries(): AsyncGenerator<{ key: string; value: Document }, void, unknown> {
    const primaryTree = this.indexes.get('id')!;
    for await (const { key: docId, value: startBlockId } of primaryTree.entries()) {
      const docBuffer = await this.documentHeap.readBlob(startBlockId);
      if (docBuffer.length === 0) continue;
      try {
        const doc = JSON.parse(docBuffer.toString()) as Document;
        yield { key: docId, value: doc };
      } catch {
        // skip invalid document payloads
        continue;
      }
    }
  }

  /**
   * Gets the list of indexed fields.
   */
  getIndexedFields(): string[] {
    return Array.from(this.indexes.keys()).filter((field) => field !== 'id');
  }

  /**
   * Gets a secondary index tree for a field.
   */
  getIndex(
    fieldName: string,
  ): BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>> | undefined {
    return this.indexes.get(fieldName);
  }

  /**
   * Sets secondary indexes (used when loading from disk).
   */
  setIndexes(
    indexes: Map<string, BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>>,
  ): void {
    const primaryTree = this.indexes.get('id');
    this.indexes = indexes;
    // ensure 'id' is always preserved or updated
    if (primaryTree !== undefined && !this.indexes.has('id')) {
      this.indexes.set('id', primaryTree);
    }
  }

  setAutoCreateSecondaryIndexesOnInsert(enabled: boolean): void {
    this.autoCreateSecondaryIndexesOnInsert = enabled;
  }

  isAutoCreateSecondaryIndexesOnInsertEnabled(): boolean {
    return this.autoCreateSecondaryIndexesOnInsert;
  }

  async buildMissingSecondaryIndexes(): Promise<string[]> {
    if (this.createIndexStorage === undefined) {
      throw new Error('Cannot build indexes: createIndexStorage is not configured for this collection.');
    }

    let missingFields = Array.from(this.pendingDeferredIndexFields)
      .filter((fieldName) => isIndexableField(fieldName) && !this.indexes.has(fieldName))
      .sort((a, b) => a.localeCompare(b));

    if (missingFields.length === 0) {
      missingFields = await this.collectMissingIndexFieldsFromDocuments();
    }

    if (missingFields.length === 0) {
      return [];
    }

    const createdIndexes = await this.buildMultipleIndexes(missingFields);
    for (const { fieldName } of createdIndexes) {
      this.pendingDeferredIndexFields.delete(fieldName);
    }

    await this.persistCreatedIndexesMetadata(createdIndexes);
    return createdIndexes.map((indexInfo) => indexInfo.fieldName);
  }

  /**
   * Builds secondary indexes from pre-sorted entries (e.g., from parallel index builder).
   * Much faster than buildMissingSecondaryIndexes because it skips the expensive document scan.
   *
   * @param {Map<string, Array<{ key: string; value: number }>>} sortedEntriesByField - Pre-sorted entries per field
   * @returns {Promise<string[]>} The field names for which indexes were created
   */
  async buildSecondaryIndexesFromSortedEntries(
    sortedEntriesByField: Map<string, Array<{ key: string; value: number }>>,
  ): Promise<string[]> {
    if (this.createIndexStorage === undefined) {
      throw new Error('Cannot build indexes: createIndexStorage is not configured for this collection.');
    }

    if (sortedEntriesByField.size === 0) {
      return [];
    }

    const createdFieldNames: string[] = [];
    const primaryTree = this.indexes.get('id');

    if (primaryTree === undefined) {
      throw new Error('Primary ID index is not available for resolving document block IDs.');
    }

    const resolveBlockIdFromKey = async (key: string): Promise<number | null> => {
      const colonIndex = key.lastIndexOf(':');
      if (colonIndex === -1) {
        return null;
      }

      const docId = key.substring(colonIndex + 1);
      const startBlockId = await primaryTree.search(docId);
      return startBlockId;
    };

    for (const [fieldName, sortedEntries] of sortedEntriesByField.entries()) {
      if (!isIndexableField(fieldName) || this.indexes.has(fieldName)) {
        continue;
      }

      const resolvedEntries: Array<{ key: string; value: number }> = [];
      for (const entry of sortedEntries) {
        const startBlockId = await resolveBlockIdFromKey(entry.key);
        if (startBlockId !== null) {
          resolvedEntries.push({
            key: entry.key,
            value: startBlockId,
          });
        }
      }

      const storage = this.createIndexStorage();
      const indexTree = new BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>(
        storage,
        this.secondaryIndexOrder,
      );
      await indexTree.init();
      indexTree.beginTransaction();

      try {
        const root = await this.buildIndexTreeBottomUp(indexTree, resolvedEntries, this.secondaryIndexOrder);
        if (root !== null) {
          indexTree.load(root);
        }

        await indexTree.commitTransaction();
      } catch (error) {
        indexTree.abortTransaction();
        throw error;
      }

      this.indexes.set(fieldName, indexTree);
      await this.flushBuiltIndexField({ fieldName, indexTree, storage });
      createdFieldNames.push(fieldName);
    }

    return createdFieldNames;
  }

  /**
   * Builds secondary indexes from disk-backed entry sources without materializing
   * all entries in memory. Each field is consumed as a stream.
   */
  async buildSecondaryIndexesFromEntrySources(
    entrySourcesByField: Map<string, DiskBackedIndexStorage>,
  ): Promise<string[]> {
    if (this.createIndexStorage === undefined) {
      throw new Error('Cannot build indexes: createIndexStorage is not configured for this collection.');
    }

    if (entrySourcesByField.size === 0) {
      return [];
    }

    const primaryTree = this.indexes.get('id');
    if (primaryTree === undefined) {
      throw new Error('Primary ID index is not available for resolving document block IDs.');
    }

    const createdFieldNames: string[] = [];

    for (const [fieldName, entrySource] of entrySourcesByField.entries()) {
      try {
        if (!isIndexableField(fieldName) || this.indexes.has(fieldName)) {
          continue;
        }

        const storage = this.createIndexStorage();
        const indexTree = new BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>(
          storage,
          this.secondaryIndexOrder,
        );
        await indexTree.init();
        indexTree.beginTransaction();

        try {
          const root = await this.buildIndexTreeBottomUpFromEntries(
            indexTree,
            this.resolveSortedEntries(entrySource.iterateSortedEntries(), primaryTree),
            this.secondaryIndexOrder,
          );

          if (root !== null) {
            indexTree.load(root);
          }

          await indexTree.commitTransaction();
        } catch (error) {
          indexTree.abortTransaction();
          throw error;
        }

        this.indexes.set(fieldName, indexTree);
        await this.flushBuiltIndexField({ fieldName, indexTree, storage });
        createdFieldNames.push(fieldName);
      } finally {
        await entrySource.cleanup();
      }
    }

    return createdFieldNames;
  }

  private async buildMultipleIndexes(fieldNames: string[]): Promise<
    Array<{
      fieldName: string;
      indexTree: BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>;
      storage: FBNodeStorage<string, number>;
    }>
  > {
    if (this.createIndexStorage === undefined) {
      throw new Error('Cannot build indexes: createIndexStorage is not configured for this collection.');
    }

    const uniqueFields = Array.from(new Set(fieldNames))
      .filter((fieldName) => isIndexableField(fieldName) && !this.indexes.has(fieldName))
      .sort((a, b) => a.localeCompare(b));

    if (uniqueFields.length === 0) {
      return [];
    }

    const entriesByField = new Map<string, Array<{ key: string; value: number }>>();
    for (const fieldName of uniqueFields) {
      entriesByField.set(fieldName, []);
    }

    const primaryTree = this.indexes.get('id')!;
    for await (const { key: docId, value: startBlockId } of primaryTree.entries()) {
      const docBuffer = await this.documentHeap.readBlob(startBlockId);
      if (docBuffer.length === 0) {
        continue;
      }

      const doc = JSON.parse(docBuffer.toString()) as Document;
      for (const fieldName of uniqueFields) {
        const fieldValue = doc[fieldName];
        if (fieldValue === undefined || fieldValue === null) {
          continue;
        }

        entriesByField.get(fieldName)!.push({
          key: serializeFieldValue(fieldValue) + ':' + docId,
          value: startBlockId,
        });
      }
    }

    const createdIndexes: Array<{
      fieldName: string;
      indexTree: BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>;
      storage: FBNodeStorage<string, number>;
    }> = [];

    for (const fieldName of uniqueFields) {
      const storage = this.createIndexStorage();
      const indexTree = new BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>(
        storage,
        this.secondaryIndexOrder,
      );
      await indexTree.init();
      indexTree.beginTransaction();

      try {
        const entries = entriesByField.get(fieldName)!;
        entries.sort((a, b) => {
          if (a.key < b.key) return -1;
          if (a.key > b.key) return 1;
          return a.value - b.value;
        });

        const root = await this.buildIndexTreeBottomUp(indexTree, entries, this.secondaryIndexOrder);
        if (root !== null) {
          indexTree.load(root);
        }

        await indexTree.commitTransaction();
      } catch (error) {
        indexTree.abortTransaction();
        throw error;
      }

      this.indexes.set(fieldName, indexTree);
      createdIndexes.push({ fieldName, indexTree, storage });
    }

    if (this.onIndexTreesCommitted) {
      await this.onIndexTreesCommitted();
    }

    return createdIndexes;
  }

  private async collectMissingIndexFieldsFromDocuments(): Promise<string[]> {
    const primaryTree = this.indexes.get('id')!;
    const missingFields = new Set<string>();

    for await (const { value: startBlockId } of primaryTree.entries()) {
      const docBuffer = await this.documentHeap.readBlob(startBlockId);
      if (docBuffer.length === 0) {
        continue;
      }

      const doc = JSON.parse(docBuffer.toString()) as Document;
      for (const [fieldName, fieldValue] of Object.entries(doc)) {
        if (
          fieldValue !== undefined &&
          fieldValue !== null &&
          isIndexableField(fieldName) &&
          !this.indexes.has(fieldName)
        ) {
          missingFields.add(fieldName);
        }
      }
    }

    return Array.from(missingFields).sort((a, b) => a.localeCompare(b));
  }

  private async persistCreatedIndexesMetadata(
    createdIndexes: Array<{
      fieldName: string;
      indexTree: BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>;
      storage: FBNodeStorage<string, number>;
    }>,
  ): Promise<void> {
    if (!this.onIndexCreated) {
      return;
    }

    const persistedIndexes = new Array<{ fieldName: string; rootBlockId: number }>();
    for (const { fieldName, indexTree, storage } of createdIndexes) {
      const root = indexTree.getRoot();
      if (root.blockId === undefined || root.blockId === NO_BLOCK) {
        if (root.isLeaf) {
          await storage.persistLeaf(root);
        } else {
          await storage.persistInternal(root);
        }
      }
      persistedIndexes.push({ fieldName, rootBlockId: root.blockId! });
    }

    if (persistedIndexes.length > 0) {
      await this.onIndexCreated(persistedIndexes);
    }
  }

  private async flushBuiltIndexField(createdIndex: {
    fieldName: string;
    indexTree: BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>;
    storage: FBNodeStorage<string, number>;
  }): Promise<void> {
    await this.persistCreatedIndexesMetadata([createdIndex]);

    if (this.onIndexTreesCommitted) {
      await this.onIndexTreesCommitted();
    }

    for (const [, committedTree] of this.indexes.entries()) {
      const maybeCacheSizedStorage = committedTree.getStorage() as unknown as {
        clearMemoryCache?: () => void;
      };

      if (maybeCacheSizedStorage.clearMemoryCache) {
        try {
          maybeCacheSizedStorage.clearMemoryCache();
        } catch {
          // ignore errors from cache clear
        }
      }
    }

    this.indexes.delete(createdIndex.fieldName);

    requestGarbageCollection();
  }

  /**
   * Inserts a document into the collection.
   * If the document does not have an id, one will be generated.
   * @param {Omit<Document, 'id'> & { id?: string }} doc The document to insert.
   * @returns {Promise<Document>} The inserted document.
   */
  async insert(doc: Omit<Document, 'id'> & { id?: string }): Promise<Document> {
    const id = doc.id || randomUUID();

    const newDoc: Document = JSON.parse(JSON.stringify({ ...doc, id })) as Document;
    const docBuffer = Buffer.from(JSON.stringify(newDoc));

    if (!(this.hnswIndex === undefined)) {
      const text = JSON.stringify(newDoc);

      await this.hnswIndex.insert(text, id);
    }

    // Allocate space and write document to the heap
    const startBlockId = await this.documentHeap.allocateAndWrite(docBuffer);

    // Insert to all available indexes
    for (const [fieldName, indexTree] of this.indexes.entries()) {
      if (fieldName === 'id') {
        await indexTree.insert(id, startBlockId);
        continue;
      }

      const fieldValue = newDoc[fieldName];
      if (fieldValue !== undefined && fieldValue !== null) {
        const indexKey = serializeFieldValue(fieldValue) + ':' + id;
        await indexTree.insert(indexKey, startBlockId);
      }
    }

    const indexesToCreate: Array<{
      fieldName: string;
      indexTree: BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>;
      storage: FBNodeStorage<string, number>;
    }> = [];
    if (this.autoCreateSecondaryIndexesOnInsert) {
      for (const [key, value] of Object.entries(newDoc)) {
        if (value !== undefined && value !== null) {
          if (isIndexableField(key) && !this.indexes.has(key)) {
            // checks if this has the createIndexStorage method
            if (this.createIndexStorage) {
              const indexInfo = await this.createIndex(key, this.createIndexStorage());
              indexesToCreate.push(indexInfo);
            }
          }
        }
      }

      await this.persistCreatedIndexesMetadata(indexesToCreate);
    } else {
      for (const [key, value] of Object.entries(newDoc)) {
        if (value !== undefined && value !== null && isIndexableField(key) && !this.indexes.has(key)) {
          this.pendingDeferredIndexFields.add(key);
        }
      }
    }

    // checks if this has the method onChangeCallback
    if (this.onChangeCallback) {
      await this.onChangeCallback();
    }

    if (this.cachedDocumentCount === null) {
      this.cachedDocumentCount = 1;
    } else {
      this.cachedDocumentCount++;
    }

    // checks if this has the method onDocumentCountChanged
    if (this.onDocumentCountChanged) {
      await this.onDocumentCountChanged(this.cachedDocumentCount);
    }

    return newDoc;
  }

  /**
   * Inserts multiple documents into the collection as a batch.
   * Persistance is done per batch instead of per document, minimizing costly disk writes.
   * If a document does not have an id, one will be generated.
   * **NOTE**: if autoCreateSecondaryIndexesOnInsert is enabled, this method will create missing indexes one by one during the batch insert, which can lead to long insert times if many documents with many different fields are inserted and there are no indexes yet. It is recommended to disable autoCreateSecondaryIndexesOnInsert and call buildMissingSecondaryIndexes after the batch insert in such cases.
   * @param docs An array of documents to insert.
   * @returns A promise resolving to the inserted documents.
   */
  async insertMany(
    docs: Array<Omit<Document, 'id'> & { id?: string }>,
    onInsertedBatch?: (
      insertedDocs: Array<{ id: string; doc: Document; startBlockId: number }>,
    ) => void | Promise<void>,
  ): Promise<Document[]> {
    const batchStart = isDebugEnabled() ? performance.now() : 0;
    let prepareMs = 0;
    let heapWriteMs = 0;
    let indexInsertMs = 0;
    let createIndexMs = 0;
    let treeCommitMs = 0;
    let callbackMs = 0;

    const prepareStart = isDebugEnabled() ? performance.now() : 0;
    const missingIndexes = new Set<string>();
    const preparedDocs: Array<{ id: string; doc: Document; docBuffer: Buffer }> = [];
    for (const doc of docs) {
      const id = doc.id || randomUUID();
      const newDoc: Document = JSON.parse(JSON.stringify({ ...doc, id })) as Document;
      const docBuffer = Buffer.from(JSON.stringify(newDoc));
      preparedDocs.push({ id, doc: newDoc, docBuffer });

      if (this.autoCreateSecondaryIndexesOnInsert) {
        for (const [key, value] of Object.entries(newDoc)) {
          if (value !== undefined && value !== null && isIndexableField(key) && !this.indexes.has(key)) {
            missingIndexes.add(key);
          }
        }
      } else {
        for (const [key, value] of Object.entries(newDoc)) {
          if (value !== undefined && value !== null && isIndexableField(key) && !this.indexes.has(key)) {
            this.pendingDeferredIndexFields.add(key);
          }
        }
      }
    }
    if (isDebugEnabled()) {
      prepareMs = performance.now() - prepareStart;
    }

    const heapWriteStart = isDebugEnabled() ? performance.now() : 0;
    const startBlockIds = await this.documentHeap.allocateAndWriteMany(preparedDocs.map((entry) => entry.docBuffer));
    if (isDebugEnabled()) {
      heapWriteMs = performance.now() - heapWriteStart;
    }

    const insertedDocs: Array<{ id: string; doc: Document; startBlockId: number }> = [];
    for (let i = 0; i < preparedDocs.length; i++) {
      insertedDocs.push({
        id: preparedDocs[i].id,
        doc: preparedDocs[i].doc,
        startBlockId: startBlockIds[i],
      });
    }

    if (this.hnswIndex !== undefined) {
      for (const { id, doc } of insertedDocs) {
        const text = JSON.stringify(doc);
        await this.hnswIndex.insert(text, id);
      }
    }

    const transactionalTreeEntries = Array.from(this.indexes.entries());
    const transactionalTrees = transactionalTreeEntries.map(([, tree]) => tree);
    for (const tree of transactionalTrees) {
      tree.beginTransaction();
    }

    try {
      const indexInsertStart = isDebugEnabled() ? performance.now() : 0;
      for (const { id, doc, startBlockId } of insertedDocs) {
        for (const [fieldName, indexTree] of this.indexes.entries()) {
          if (fieldName === 'id') {
            await indexTree.insert(id, startBlockId);
            continue;
          }

          const fieldValue = doc[fieldName];
          if (fieldValue !== undefined && fieldValue !== null) {
            const indexKey = serializeFieldValue(fieldValue) + ':' + id;
            await indexTree.insert(indexKey, startBlockId);
          }
        }
      }
      if (isDebugEnabled()) {
        indexInsertMs = performance.now() - indexInsertStart;
      }

      const createIndexStart = isDebugEnabled() ? performance.now() : 0;
      const createdIndexes: Array<{
        fieldName: string;
        indexTree: BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>;
        storage: FBNodeStorage<string, number>;
      }> = [];
      for (const key of missingIndexes) {
        if (this.createIndexStorage) {
          const indexInfo = await this.createIndex(key, this.createIndexStorage());
          createdIndexes.push(indexInfo);
        }
      }
      if (isDebugEnabled()) {
        createIndexMs = performance.now() - createIndexStart;
      }

      await this.persistCreatedIndexesMetadata(createdIndexes);

      const treeCommitStart = isDebugEnabled() ? performance.now() : 0;
      for (const [fieldName, tree] of transactionalTreeEntries) {
        if (tree.commitTransaction) {
          const singleTreeCommitStart = isDebugEnabled() ? performance.now() : 0;
          await tree.commitTransaction();
          if (isDebugEnabled()) {
            const singleTreeCommitMs = performance.now() - singleTreeCommitStart;
            const treeStorage = tree.getStorage();
            const maybeCacheSizedStorage = treeStorage as { getCacheSize?: () => number };
            const cacheSize = maybeCacheSizedStorage.getCacheSize ? maybeCacheSizedStorage.getCacheSize() : -1;
            console.log(
              `[INSERT_MANY_TREE_COMMIT_PROFILE] field=${fieldName} commit=${singleTreeCommitMs.toFixed(2)}ms cacheSize=${cacheSize}`,
            );
          }
        }
      }

      if (this.onIndexTreesCommitted) {
        await this.onIndexTreesCommitted();
      }
      if (isDebugEnabled()) {
        treeCommitMs = performance.now() - treeCommitStart;
      }

      const callbackStart = isDebugEnabled() ? performance.now() : 0;

      if (insertedDocs.length > 0) {
        if (this.cachedDocumentCount === null) {
          this.cachedDocumentCount = insertedDocs.length;
        } else {
          this.cachedDocumentCount += insertedDocs.length;
        }

        if (this.onDocumentCountChanged && this.cachedDocumentCount !== null) {
          await this.onDocumentCountChanged(this.cachedDocumentCount);
        }
      }

      if (this.onChangeCallback && insertedDocs.length > 0) {
        await this.onChangeCallback();
      }

      if (isDebugEnabled()) {
        callbackMs = performance.now() - callbackStart;
        const totalMs = performance.now() - batchStart;
        console.log(
          `[INSERT_MANY_PROFILE] docs=${docs.length} indexes=${this.indexes.size} missingIndexes=${missingIndexes.size} total=${totalMs.toFixed(2)}ms prepare=${prepareMs.toFixed(2)}ms heapWrite=${heapWriteMs.toFixed(2)}ms indexInsert=${indexInsertMs.toFixed(2)}ms createIndex=${createIndexMs.toFixed(2)}ms treeCommit=${treeCommitMs.toFixed(2)}ms callbacks=${callbackMs.toFixed(2)}ms`,
        );
      }
    } catch (error) {
      for (const tree of transactionalTrees) {
        if (tree.abortTransaction) {
          tree.abortTransaction();
        }
      }
      throw error;
    }

    if (onInsertedBatch) {
      await onInsertedBatch(insertedDocs);
    }

    return insertedDocs.map((d) => d.doc);
  }

  /**
   * Inserts multiple documents and returns the allocated heap block ID per inserted document.
   * This is useful for bulk index pipelines that can store block IDs directly and skip
   * a later primary-index lookup phase.
   */
  async insertManyWithBlockIds(
    docs: Array<Omit<Document, 'id'> & { id?: string }>,
  ): Promise<Array<{ doc: Document; startBlockId: number }>> {
    const result: Array<{ doc: Document; startBlockId: number }> = [];
    await this.insertMany(docs, (insertedBatch) => {
      for (const inserted of insertedBatch) {
        result.push({ doc: inserted.doc, startBlockId: inserted.startBlockId });
      }
    });
    return result;
  }

  /**
   * Applies filter operators to get matching document IDs using indexes.
   * @param {FilterOperators} filterOps The filter operators to apply.
   * @returns {Promise<Set<string> | null>} A set of document IDs that match the query, or null if no index is available.
   */
  async applyFilterOps(filterOps: FilterOperators): Promise<Set<number> | null> {
    const indexedFields: Array<{ field: string; ops: FilterOperators[string]; score: number }> = [];

    for (const [field, ops] of Object.entries(filterOps)) {
      if (!this.indexes.has(field) || field === 'id') continue;

      let score = Infinity;
      if (ops.$eq !== undefined) score = 1;
      else if (ops.$in !== undefined) score = ops.$in.length;
      else if (ops.$gt !== undefined || ops.$gte !== undefined || ops.$lt !== undefined || ops.$lte !== undefined) {
        score = 100;
      } else {
        continue;
      }

      indexedFields.push({ field, ops, score });
    }

    if (indexedFields.length === 0) return null;
    indexedFields.sort((a, b) => a.score - b.score); // ASC

    const matchesOpsOnValue = (value: DocumentValue | undefined, ops: FilterOperators[string]): boolean => {
      if (ops.$eq !== undefined && value !== ops.$eq) return false;
      if (ops.$in !== undefined && !ops.$in.includes(value as DocumentValue)) return false;

      if (ops.$gt !== undefined) {
        if (value === null || value === undefined) return false;
        if (!((value as unknown as number) > (ops.$gt as unknown as number))) return false;
      }
      if (ops.$gte !== undefined) {
        if (value === null || value === undefined) return false;
        if (!((value as unknown as number) >= (ops.$gte as unknown as number))) return false;
      }
      if (ops.$lt !== undefined) {
        if (value === null || value === undefined) return false;
        if (!((value as unknown as number) < (ops.$lt as unknown as number))) return false;
      }
      if (ops.$lte !== undefined) {
        if (value === null || value === undefined) return false;
        if (!((value as unknown as number) <= (ops.$lte as unknown as number))) return false;
      }

      return true;
    };

    const collectInitialPointers = async (
      indexTree: BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>,
      ops: FilterOperators[string],
    ): Promise<Set<number> | null> => {
      const pointers = new Set<number>();

      if (ops.$eq !== undefined) {
        const prefix = serializeFieldValue(ops.$eq) + ':';
        for await (const { value: startBlockId } of indexTree.range(prefix, prefix + '\uffff', {
          inclusiveStart: true,
          inclusiveEnd: true,
        })) {
          pointers.add(startBlockId);
        }
        return pointers;
      }

      if (ops.$gt !== undefined || ops.$gte !== undefined || ops.$lt !== undefined || ops.$lte !== undefined) {
        const minVal = ops.$gt !== undefined ? ops.$gt : ops.$gte;
        const maxVal = ops.$lt !== undefined ? ops.$lt : ops.$lte;
        const minInclusive = ops.$gte !== undefined;
        const maxInclusive = ops.$lte !== undefined;

        const startKey = minVal !== undefined && minVal !== null ? serializeFieldValue(minVal) + ':' : '';
        const endKey = maxVal !== undefined && maxVal !== null ? serializeFieldValue(maxVal) + ':\uffff' : '\uffff';

        for await (const { value: startBlockId } of indexTree.range(startKey, endKey, {
          inclusiveStart: minInclusive,
          inclusiveEnd: maxInclusive,
        })) {
          pointers.add(startBlockId);
        }
        return pointers;
      }

      if (ops.$in !== undefined) {
        const sortedValues = ops.$in
          .map((v) => ({ serialized: serializeFieldValue(v) }))
          .sort((a, b) => (a.serialized < b.serialized ? -1 : a.serialized > b.serialized ? 1 : 0)); // ASC

        if (sortedValues.length === 0) return pointers;

        const firstKey = sortedValues[0].serialized + ':';
        const lastKey = sortedValues[sortedValues.length - 1].serialized + ':\uffff';

        let valueIndex = 0;
        for await (const { key, value: startBlockId } of indexTree.range(firstKey, lastKey, {
          inclusiveStart: true,
          inclusiveEnd: true,
        })) {
          const colonIndex = key.lastIndexOf(':');
          const serializedValue = key.substring(0, colonIndex);

          while (valueIndex < sortedValues.length && sortedValues[valueIndex].serialized < serializedValue) {
            valueIndex++;
          }

          if (valueIndex < sortedValues.length && sortedValues[valueIndex].serialized === serializedValue) {
            pointers.add(startBlockId);
          }

          if (valueIndex >= sortedValues.length) break;
        }
      } else if (ops.$includes !== undefined && Object.keys(ops).length === 1) {
        // If $includes is the only operator, index scan is useless, skip index use for this field
        return null;
      }

      return pointers;
    };

    const [first, ...rest] = indexedFields;
    const firstIndex = this.indexes.get(first.field)!;
    let resultSet = await collectInitialPointers(firstIndex, first.ops);

    if (resultSet === null) return null;
    if (resultSet.size === 0) return resultSet;

    const docCache = new Map<number, Document | null>();

    for (const { field, ops } of rest) {
      const previousSize = resultSet.size;
      const nextSet = new Set<number>();

      for (const startBlockId of resultSet) {
        let doc = docCache.get(startBlockId);
        if (doc === undefined) {
          const docBuffer = await this.documentHeap.readBlob(startBlockId);
          if (docBuffer.length > 0) {
            doc = JSON.parse(docBuffer.toString()) as Document;
          } else {
            doc = null;
          }
          docCache.set(startBlockId, doc);
        }

        if (doc === null) continue;
        if (matchesOpsOnValue(doc[field], ops)) {
          nextSet.add(startBlockId);
        }
      }

      resultSet = nextSet;
      if (resultSet.size === 0) break;

      if (previousSize > 0 && resultSet.size / previousSize < 0.9) break;
    }

    return resultSet;
  }

  private async getCachedDocumentCount(): Promise<number> {
    if (this.cachedDocumentCount !== null) {
      return this.cachedDocumentCount;
    }

    let count = 0;
    for await (const entry of this.indexes.get('id')!.entries()) {
      void entry;
      count++;
    }

    this.cachedDocumentCount = count;
    return count;
  }

  /**
   * Finds documents in the collection.
   * @param {Query} query The query options.
   * @returns {Promise<Document[]>} An array of documents matching the query.
   */
  async find(query: Query = {}): Promise<Document[]> {
    let results: Document[] = [];
    let candidatePointers: Set<number> | null = null;
    const primaryTree = this.indexes.get('id')!;

    // Step 1: Use filter operators with indexes if available
    if (query.filterOps !== undefined) {
      candidatePointers = await this.applyFilterOps(query.filterOps);

      if (candidatePointers !== null) {
        const estimatedTotalDocs = await this.getCachedDocumentCount();
        const totalDocs = Math.max(1, estimatedTotalDocs);
        const candidateRatio = candidatePointers.size / totalDocs;
        const scanRatio = 1 - candidateRatio;

        if (candidateRatio <= scanRatio) {
          for (const startBlockId of candidatePointers) {
            const docBuffer = await this.documentHeap.readBlob(startBlockId);
            if (docBuffer.length > 0) {
              const doc = JSON.parse(docBuffer.toString()) as Document;
              let matches = true;
              for (const [field, ops] of Object.entries(query.filterOps)) {
                const value = doc[field];
                if (ops.$eq !== undefined && value !== ops.$eq) matches = false;
                if (ops.$ne !== undefined && value === ops.$ne) matches = false;
                if (ops.$gt !== undefined && ops.$gt !== null) {
                  if (typeof ops.$gt === 'string' || typeof value === 'string') {
                    throw new Error(
                      `Comparison operators ($gt, $lt, etc.) are only supported for numbers. Attempted to compare string.`,
                    );
                  }
                  if (value !== null && !((value as unknown as number) > (ops.$gt as unknown as number)))
                    matches = false;
                }
                if (ops.$gte !== undefined && ops.$gte !== null) {
                  if (typeof ops.$gte === 'string' || typeof value === 'string') {
                    throw new Error(
                      `Comparison operators ($gt, $lt, etc.) are only supported for numbers. Attempted to compare string.`,
                    );
                  }
                  if (value !== null && !((value as unknown as number) >= (ops.$gte as unknown as number)))
                    matches = false;
                }
                if (ops.$lt !== undefined && ops.$lt !== null) {
                  if (typeof ops.$lt === 'string' || typeof value === 'string') {
                    throw new Error(
                      `Comparison operators ($gt, $lt, etc.) are only supported for numbers. Attempted to compare string.`,
                    );
                  }
                  if (value !== null && !((value as unknown as number) < (ops.$lt as unknown as number)))
                    matches = false;
                }
                if (ops.$lte !== undefined && ops.$lte !== null) {
                  if (typeof ops.$lte === 'string' || typeof value === 'string') {
                    throw new Error(
                      `Comparison operators ($gt, $lt, etc.) are only supported for numbers. Attempted to compare string.`,
                    );
                  }
                  if (value !== null && !((value as unknown as number) <= (ops.$lte as unknown as number)))
                    matches = false;
                }
                if (ops.$in !== undefined && !ops.$in.includes(value)) matches = false;
                if (ops.$nin !== undefined && ops.$nin.includes(value)) matches = false;
                if (ops.$includes !== undefined && (typeof value !== 'string' || !value.includes(ops.$includes)))
                  matches = false;
              }

              if (matches && (!query.filter || query.filter(doc))) {
                results.push(doc);
              }
            }
          }
        } else {
          for await (const { value: startBlockId } of primaryTree.entries()) {
            if (!candidatePointers.has(startBlockId)) continue;

            const docBuffer = await this.documentHeap.readBlob(startBlockId);
            if (docBuffer.length === 0) continue;
            const doc = JSON.parse(docBuffer.toString()) as Document;

            let matches = true;
            for (const [field, ops] of Object.entries(query.filterOps)) {
              const value = doc[field];
              if (ops.$eq !== undefined && value !== ops.$eq) matches = false;
              if (ops.$ne !== undefined && value === ops.$ne) matches = false;
              if (ops.$gt !== undefined && ops.$gt !== null) {
                if (typeof ops.$gt === 'string' || typeof value === 'string') {
                  throw new Error(
                    `Comparison operators ($gt, $lt, etc.) are only supported for numbers. Attempted to compare string.`,
                  );
                }
                if (value !== null && !((value as unknown as number) > (ops.$gt as unknown as number))) matches = false;
              }
              if (ops.$gte !== undefined && ops.$gte !== null) {
                if (typeof ops.$gte === 'string' || typeof value === 'string') {
                  throw new Error(
                    `Comparison operators ($gt, $lt, etc.) are only supported for numbers. Attempted to compare string.`,
                  );
                }
                if (value !== null && !((value as unknown as number) >= (ops.$gte as unknown as number)))
                  matches = false;
              }
              if (ops.$lt !== undefined && ops.$lt !== null) {
                if (typeof ops.$lt === 'string' || typeof value === 'string') {
                  throw new Error(
                    `Comparison operators ($gt, $lt, etc.) are only supported for numbers. Attempted to compare string.`,
                  );
                }
                if (value !== null && !((value as unknown as number) < (ops.$lt as unknown as number))) matches = false;
              }
              if (ops.$lte !== undefined && ops.$lte !== null) {
                if (typeof ops.$lte === 'string' || typeof value === 'string') {
                  throw new Error(
                    `Comparison operators ($gt, $lt, etc.) are only supported for numbers. Attempted to compare string.`,
                  );
                }
                if (value !== null && !((value as unknown as number) <= (ops.$lte as unknown as number)))
                  matches = false;
              }
              if (ops.$in !== undefined && !ops.$in.includes(value)) matches = false;
              if (ops.$nin !== undefined && ops.$nin.includes(value)) matches = false;
              if (ops.$includes !== undefined && (typeof value !== 'string' || !value.includes(ops.$includes)))
                matches = false;
            }

            if (matches && (!query.filter || query.filter(doc))) {
              results.push(doc);
            }
          }
        }

        results = this.applyProjection(results, query.projection);
        results = this.applySorting(results, query.sort);
        return this.applyPagination(results, query.skip, query.limit);
      }
    }

    // Step 2: if no index was used
    let iterator: AsyncGenerator<{ key: string; value: number }, void, unknown>;

    if (query.idRange !== undefined) {
      const { min, max } = query.idRange;

      if (min !== undefined && max !== undefined) {
        iterator = primaryTree.range(min, max, {
          inclusiveStart: true,
          inclusiveEnd: true,
        });
      } else if (min !== undefined) {
        iterator = primaryTree.entriesFrom(min);
      } else if (max !== undefined) {
        iterator = primaryTree.entries();
        for await (const { key, value: startBlockId } of iterator) {
          if (key > max) break;
          const docBuffer = await this.documentHeap.readBlob(startBlockId);
          if (docBuffer.length > 0) {
            const doc = JSON.parse(docBuffer.toString()) as Document;
            if (!query.filter || query.filter(doc)) {
              results.push(doc);
            }
          }
        }

        results = this.applyProjection(results, query.projection);
        results = this.applySorting(results, query.sort);
        return this.applyPagination(results, query.skip, query.limit);
      } else {
        iterator = primaryTree.entries();
      }

      if (min !== undefined || max !== undefined) {
        for await (const { value: startBlockId } of iterator) {
          const docBuffer = await this.documentHeap.readBlob(startBlockId);
          if (docBuffer.length > 0) {
            const doc = JSON.parse(docBuffer.toString()) as Document;
            if (!query.filter || query.filter(doc)) {
              results.push(doc);
            }
          }
        }

        results = this.applyProjection(results, query.projection);
        results = this.applySorting(results, query.sort);
        return this.applyPagination(results, query.skip, query.limit);
      }
    }

    if (!query.filter && !query.filterOps && query.sort?.field === 'id' && query.sort.order === 'asc') {
      iterator = primaryTree.entries();

      let count = 0;
      const start = query.skip ?? 0;
      const limit = query.limit ?? Infinity;

      for await (const { value: startBlockId } of iterator) {
        if (count >= start && count < start + limit) {
          const docBuffer = await this.documentHeap.readBlob(startBlockId);
          if (docBuffer.length > 0) {
            results.push(JSON.parse(docBuffer.toString()) as Document);
          }
        }
        count++;
        if (count >= start + limit) break;
      }

      return this.applyProjection(results, query.projection);
    }

    // Handle descending ID sort
    if (query.sort?.field === 'id' && query.sort.order === 'desc') {
      const all: Document[] = [];
      for await (const { value: startBlockId } of primaryTree.reverseEntries()) {
        const docBuffer = await this.documentHeap.readBlob(startBlockId);
        if (docBuffer.length > 0) {
          const doc = JSON.parse(docBuffer.toString()) as Document;
          if (query.filter === undefined || query.filter(doc)) {
            all.push(doc);
          }
        }
      }
      // all.reverse();

      results = this.applyProjection(all, query.projection);
      return this.applyPagination(results, query.skip, query.limit);
    }

    // Full scan with filter
    iterator = primaryTree.entries();
    for await (const { value: startBlockId } of iterator) {
      const docBuffer = await this.documentHeap.readBlob(startBlockId);
      if (docBuffer.length === 0) continue;
      const doc = JSON.parse(docBuffer.toString()) as Document;

      if (query.filter !== undefined && !query.filter(doc)) {
        continue;
      }

      if (query.filterOps !== undefined) {
        let matches = true;
        for (const [field, ops] of Object.entries(query.filterOps)) {
          const docValue = doc[field] as number | string | boolean | null;
          if (ops.$eq !== undefined && docValue !== ops.$eq) matches = false;
          if (ops.$ne !== undefined && docValue === ops.$ne) matches = false;
          if (ops.$gt !== undefined && ops.$gt !== null) {
            if (typeof ops.$gt === 'string' || typeof docValue === 'string') {
              throw new Error(
                `Comparison operators ($gt, $lt, etc.) are only supported for numbers. Attempted to compare string.`,
              );
            }
            if (docValue !== null && !((docValue as number) > (ops.$gt as unknown as number))) matches = false;
          }
          if (ops.$gte !== undefined && ops.$gte !== null) {
            if (typeof ops.$gte === 'string' || typeof docValue === 'string') {
              throw new Error(
                `Comparison operators ($gt, $lt, etc.) are only supported for numbers. Attempted to compare string.`,
              );
            }
            if (docValue !== null && !((docValue as number) >= (ops.$gte as unknown as number))) matches = false;
          }
          if (ops.$lt !== undefined && ops.$lt !== null) {
            if (typeof ops.$lt === 'string' || typeof docValue === 'string') {
              throw new Error(
                `Comparison operators ($gt, $lt, etc.) are only supported for numbers. Attempted to compare string.`,
              );
            }
            if (docValue !== null && !((docValue as number) < (ops.$lt as unknown as number))) matches = false;
          }
          if (ops.$lte !== undefined && ops.$lte !== null) {
            if (typeof ops.$lte === 'string' || typeof docValue === 'string') {
              throw new Error(
                `Comparison operators ($gt, $lt, etc.) are only supported for numbers. Attempted to compare string.`,
              );
            }
            if (docValue !== null && !((docValue as number) <= (ops.$lte as unknown as number))) matches = false;
          }
          if (ops.$in !== undefined && !ops.$in.includes(docValue as Exclude<DocumentValue, object>)) matches = false;
          if (ops.$nin !== undefined && ops.$nin.includes(docValue as Exclude<DocumentValue, object>)) matches = false;
          if (ops.$includes !== undefined && (typeof docValue !== 'string' || !docValue.includes(ops.$includes)))
            matches = false;
        }

        if (!matches) {
          continue;
        }
      }

      results.push(doc);
    }

    results = this.applyProjection(results, query.projection);
    results = this.applySorting(results, query.sort);
    return this.applyPagination(results, query.skip, query.limit);
  }

  /**
   * Finds documents in the collection using keyset pagination by id.
   * @param {number} limit Maximum number of documents to return.
   * @param {string} [afterId] Return documents strictly after this id.
   * @returns {Promise<Document[]>} A page of documents.
   */
  async findPagedAfter(limit: number, afterId?: string): Promise<Document[]> {
    const safeLimit = Math.max(1, Math.floor(limit));
    const primaryTree = this.indexes.get('id');

    if (primaryTree === undefined) {
      throw new Error('Primary ID index is not available');
    }

    const results: Document[] = [];
    const iterator = afterId !== undefined ? primaryTree.entriesFrom(afterId) : primaryTree.entries();

    for await (const { key, value: startBlockId } of iterator) {
      if (afterId !== undefined && key === afterId) {
        continue;
      }

      const docBuffer = await this.documentHeap.readBlob(startBlockId);
      if (docBuffer.length === 0) {
        continue;
      }

      results.push(JSON.parse(docBuffer.toString()) as Document);

      if (results.length >= safeLimit) {
        break;
      }
    }

    return results;
  }

  /**
   * Keyset-paginated find with an inline filter predicate.
   * Walks the primary B-tree from afterId and stops as soon as limit matching
   * documents are collected — O(limit) for dense user data, never O(n).
   */
  async findPagedAfterWithFilter(
    limit: number,
    filter: (doc: Document) => boolean,
    afterId?: string,
  ): Promise<Document[]> {
    const safeLimit = Math.max(1, Math.floor(limit));
    const primaryTree = this.indexes.get('id');
    if (primaryTree === undefined) throw new Error('Primary ID index is not available');

    const results: Document[] = [];
    const iterator = afterId !== undefined ? primaryTree.entriesFrom(afterId) : primaryTree.entries();

    for await (const { key, value: startBlockId } of iterator) {
      if (afterId !== undefined && key === afterId) continue;
      const docBuffer = await this.documentHeap.readBlob(startBlockId);
      if (docBuffer.length === 0) continue;
      const doc = JSON.parse(docBuffer.toString()) as Document;
      if (filter(doc)) {
        results.push(doc);
        if (results.length >= safeLimit) break;
      }
    }

    return results;
  }

  /**
   * Counts documents matching a predicate without building a results array.
   * Still O(n) disk reads, but uses O(1) memory.
   */
  async countWhere(filter: (doc: Document) => boolean): Promise<number> {
    const primaryTree = this.indexes.get('id');
    if (primaryTree === undefined) throw new Error('Primary ID index is not available');

    let count = 0;
    for await (const { value: startBlockId } of primaryTree.entries()) {
      const docBuffer = await this.documentHeap.readBlob(startBlockId);
      if (docBuffer.length === 0) continue;
      const doc = JSON.parse(docBuffer.toString()) as Document;
      if (filter(doc)) count++;
    }
    return count;
  }

  /**
   * Counts matching documents with id <= upToId.
   * Used to compute the rangeStart offset for cursor-based pagination — O(position), not O(n).
   */
  async countWhereUpTo(filter: (doc: Document) => boolean, upToId: string): Promise<number> {
    const primaryTree = this.indexes.get('id');
    if (primaryTree === undefined) throw new Error('Primary ID index is not available');

    let count = 0;
    for await (const { key, value: startBlockId } of primaryTree.entries()) {
      if (key > upToId) break;
      const docBuffer = await this.documentHeap.readBlob(startBlockId);
      if (docBuffer.length === 0) continue;
      const doc = JSON.parse(docBuffer.toString()) as Document;
      if (filter(doc)) count++;
    }
    return count;
  }

  /**
   * Counts the total number of documents in the collection.
   * @returns {Promise<number>} The total document count.
   */
  async countDocuments(): Promise<number> {
    if (this.firstCountDoc) {
      // After restart. Go to disk to get the actual counts, or they will be 0.
      this.firstCountDoc = false;
      const docCount: number = (await this.find()).length; // don't use the cached one.
      this.cachedDocumentCount = docCount;
    }
    return this.getCachedDocumentCount();
  }

  /**
   * Performs aggregation on the collection.
   * Uses secondary indexes when available for efficient grouping (O(log n + k)).
   * @param {object} options The aggregation options.
   * @param {string} options.groupBy The field to group by.
   * @param {object} options.operations The aggregation operations to perform.
   * @param {string} [options.operations.count] Optional field name to store count.
   * @param {Array<{ field: string; as: string }>} [options.operations.sum] Optional sum operations.
   * @param {Array<{ field: string; as: string }>} [options.operations.avg] Optional average operations.
   * @param {Array<{ field: string; as: string }>} [options.operations.min] Optional min operations.
   * @param {Array<{ field: string; as: string }>} [options.operations.max] Optional max operations.
   * @param {(doc: Document) => boolean} [options.filter] Optional filter function to apply before aggregation.
   * @returns {Promise<Document[]>} The aggregation results.
   */
  async aggregate(options: {
    groupBy?: string | null;
    operations: {
      count?: string;
      sum?: Array<{ field: string; as: string }>;
      avg?: Array<{ field: string; as: string }>;
      min?: Array<{ field: string; as: string }>;
      max?: Array<{ field: string; as: string }>;
    };
    filter?: (doc: Document) => boolean;
  }): Promise<Document[]> {
    const { groupBy, operations, filter } = options;
    const groups = new Map<DocumentValue, Document[]>();
    const primaryTree = this.indexes.get('id')!;

    // Use secondary index if available fr grouping
    let iterator: AsyncIterable<{ key: string; value: number }>;

    if (groupBy && this.indexes.has(groupBy) && groupBy !== 'id') {
      const indexTree = this.indexes.get(groupBy)!;
      iterator = indexTree.entries();

      for await (const { value: startBlockId } of iterator) {
        const docBuffer = await this.documentHeap.readBlob(startBlockId);
        if (docBuffer.length === 0) continue;
        const doc = JSON.parse(docBuffer.toString()) as Document;
        if (filter !== undefined && !filter(doc)) continue;

        const groupValue = doc[groupBy];
        const groupKey = typeof groupValue === 'object' ? JSON.stringify(groupValue) : String(groupValue);

        if (!groups.has(groupKey)) {
          groups.set(groupKey, []);
        }
        groups.get(groupKey)!.push(doc);
      }
    } else {
      // Full scan
      for await (const { value: startBlockId } of primaryTree.entries()) {
        const docBuffer = await this.documentHeap.readBlob(startBlockId);
        if (docBuffer.length === 0) continue;
        const doc = JSON.parse(docBuffer.toString()) as Document;
        if (filter !== undefined && !filter(doc)) continue;

        const groupValue = groupBy ? doc[groupBy] : '_all_';
        const groupKey =
          typeof groupValue === 'object' && groupValue !== null ? JSON.stringify(groupValue) : String(groupValue);

        if (!groups.has(groupKey)) {
          groups.set(groupKey, []);
        }
        groups.get(groupKey)!.push(doc);
      }
    }

    // Compute aggregations for each group
    const results: Document[] = [];
    for (const [groupKey, docs] of groups.entries()) {
      const result: Document = groupBy
        ? { id: `group_${groupKey as string}`, [groupBy]: docs[0][groupBy] }
        : { id: `group_all` };

      if (operations.count !== undefined) {
        result[operations.count] = docs.length;
      }

      if (operations.sum !== undefined) {
        for (const { field, as } of operations.sum) {
          result[as] = docs.reduce((sum, doc) => {
            const val = doc[field];
            return sum + (typeof val === 'number' ? val : 0);
          }, 0);
        }
      }

      if (operations.avg !== undefined) {
        for (const { field, as } of operations.avg) {
          const sum = docs.reduce((s, doc) => {
            const val = doc[field];
            return s + (typeof val === 'number' ? val : 0);
          }, 0);
          result[as] = docs.length > 0 ? sum / docs.length : 0;
        }
      }

      if (operations.min !== undefined) {
        for (const { field, as } of operations.min) {
          const values = docs.map((d) => d[field]).filter((v) => typeof v === 'number');
          result[as] = values.length > 0 ? Math.min(...values) : null;
        }
      }

      if (operations.max !== undefined) {
        for (const { field, as } of operations.max) {
          const values = docs.map((d) => d[field]).filter((v) => typeof v === 'number');
          result[as] = values.length > 0 ? Math.max(...values) : null;
        }
      }

      results.push(result);
    }

    return results;
  }

  /**
   * Applies projection to results (SELECT specific fields).
   */
  applyProjection(docs: Document[], fields?: string[]): Document[] {
    if (fields === undefined || fields.length === 0) {
      return docs;
    }

    return docs.map((doc) => {
      const projected: Document = { id: doc.id };
      for (const field of fields) {
        if (field !== 'id' && doc[field] !== undefined) {
          projected[field] = doc[field];
        }
      }
      return projected;
    });
  }

  /**
   * Applies sorting to results.
   */
  private applySorting(docs: Document[], sort?: { field: string; order: 'asc' | 'desc' }): Document[] {
    if (!sort || sort.field === 'id') {
      return docs;
    }

    return docs.sort((a, b) => {
      const valA = a[sort.field];
      const valB = b[sort.field];
      if (valA === null || valA === undefined) return 1;
      if (valB === null || valB === undefined) return -1;
      if ((valA as unknown as number) < (valB as unknown as number)) return sort.order === 'asc' ? -1 : 1;
      if ((valA as unknown as number) > (valB as unknown as number)) return sort.order === 'asc' ? 1 : -1;
      return 0;
    });
  }

  /**
   * Applies pagination to results.
   */
  private applyPagination(docs: Document[], skip?: number, limit?: number): Document[] {
    const start = skip ?? 0;
    const end = limit ? start + limit : undefined;
    return docs.slice(start, end);
  }

  /**
   * Retrieves a document by its ID.
   * @param {string} id The ID of the document.
   * @returns {Promise<Document | null>} The document, or null if not found.
   */
  async findById(id: string): Promise<Document | null> {
    const primaryTree = this.indexes.get('id')!;
    const startBlockId = await primaryTree.search(id);
    if (startBlockId === null) return null;

    const docBuffer = await this.documentHeap.readBlob(startBlockId);
    if (docBuffer.length === 0) return null;
    return JSON.parse(docBuffer.toString()) as Document;
  }

  /**
   * Updates a document in the collection.
   * @param {string} id The ID of the document to update.
   * @param {Partial<Document>} updates Partial document with updates.
   * @returns {Promise<Document | null>} The updated document, or null if not found.
   */
  async update(id: string, updates: Partial<Document>): Promise<Document | null> {
    const primaryTree = this.indexes.get('id')!;
    const startBlockId = await primaryTree.search(id);
    if (startBlockId === null) return null;

    const docBuffer = await this.documentHeap.readBlob(startBlockId);
    if (docBuffer.length === 0) return null;

    const existing = JSON.parse(docBuffer.toString()) as Document;
    const updated: Document = structuredClone({ ...existing, ...updates, id });

    // Remove old index entries and add new ones for changed fields
    for (const [fieldName, indexTree] of this.indexes.entries()) {
      if (fieldName === 'id') continue; // id can't change via update

      const oldValue = existing[fieldName];
      const newValue = updated[fieldName];

      // If value changed, remove old entry from index
      if (oldValue !== newValue && oldValue !== undefined && oldValue !== null) {
        const oldIndexKey = serializeFieldValue(oldValue) + ':' + id;
        await indexTree.delete(oldIndexKey);
      }

      // Add new entry to index if value exists
      if (newValue !== undefined && newValue !== null && oldValue !== newValue) {
        const newIndexKey = serializeFieldValue(newValue) + ':' + id;
        await indexTree.insert(newIndexKey, startBlockId);
      }
    }

    // Overwrite the document in the heap
    await this.documentHeap.overwriteBlock(startBlockId, Buffer.from(JSON.stringify(updated)));

    if (this.onChangeCallback) {
      await this.onChangeCallback();
    }

    if (!(this.hnswIndex === undefined)) {
      const updatedDoc = JSON.stringify(await this.findById(id));
      await this.hnswIndex.delete(id);
      await this.hnswIndex.insert(updatedDoc, id);
    }

    return JSON.parse(JSON.stringify(updated)) as Document;
  }

  /**
   * Deletes a document from the collection.
   * @param {string} id The ID of the document to delete.
   * @returns {Promise<boolean>} True if the document was deleted, false if not found.
   */
  async delete(id: string): Promise<boolean> {
    const primaryTree = this.indexes.get('id')!;
    const startBlockId = await primaryTree.search(id);
    if (startBlockId === null) return false;

    if (!(this.hnswIndex === undefined)) {
      await this.hnswIndex.delete(id);
    }

    const docBuffer = await this.documentHeap.readBlob(startBlockId);
    if (docBuffer.length === 0) return false;
    const existing = JSON.parse(docBuffer.toString()) as Document;

    // Remove from all secondary indexes
    for (const [fieldName, indexTree] of this.indexes.entries()) {
      if (fieldName === 'id') continue;
      const fieldValue = existing[fieldName];
      if (fieldValue !== undefined && fieldValue !== null) {
        const indexKey = serializeFieldValue(fieldValue) + ':' + id;
        await indexTree.delete(indexKey);
      }
    }

    // Remove from primary index and free heap memory
    await primaryTree.delete(id);
    await this.documentHeap.freeBlob(startBlockId);

    if (this.cachedDocumentCount !== null && this.cachedDocumentCount > 0) {
      this.cachedDocumentCount--;
    }

    // checks if this has the onDocumentCountChanged method
    if (this.onDocumentCountChanged && this.cachedDocumentCount !== null) {
      await this.onDocumentCountChanged(this.cachedDocumentCount);
    }

    // checks if this has the onChangeCallback method
    if (this.onChangeCallback) {
      await this.onChangeCallback();
    }

    return true;
  }

  //Interactions with HNSW//

  /**
   * Search the database with a query using the hsnw.
   *
   * @param {string} query - The query to search with.
   * @returns {string | string[]} - The n best matches.
   * @throws {Error} If the simpledbms is not using a hnsw index.
   */
  async hnswSearch(query: string, nBestMatches: number = 1): Promise<string | string[]> {
    if (this.hnswIndex === undefined) {
      throw new Error('This instance of simpledbms does not have a hnsw index.');
    }

    const res = await this.hnswIndex?.search(query, nBestMatches);
    if (nBestMatches === 1) {
      return res[0];
    } else {
      return res;
    }
  }
}

export type QueryStatementType = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
/**
 * The SimpleDBMS database manager.
 */
export class SimpleDBMS {
  private fbFile: FreeBlockFile;
  private documentHeap: FreeBlockFile;
  private catalogTree!: BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>;
  private catalogStorage!: FBNodeStorage<string, number>;
  private collections: Map<string, Collection> = new Map();
  private hnswIndex: hnswIndexImpl | undefined;
  private catalogAutoCommitEnabled = true;

  private constructor(fbFile: FreeBlockFile, documentHeap: FreeBlockFile, hnswIndex?: hnswIndexImpl) {
    this.fbFile = fbFile;
    this.documentHeap = documentHeap;
    this.hnswIndex = hnswIndex;
  }

  /* QUERY */

  /**
   * Creates a storage adapter bound to the currently initialized SimpleDBMS instance.
   * @returns {SimpleDBMSStorageAdapter} Storage adapter used by the query-language executors.
   */
  getQueryLanguageStorageAdapter(): SimpleDBMSStorageAdapter {
    return new SimpleDBMSStorageAdapter(this);
  }

  /**
   * Extracts the first supported query text field from a request body.
   * @param body Parsed request body.
   * @returns {string | null} The first non-empty query text, sql text, or prompt value.
   */
  extractQueryText(body: unknown): string | null {
    if (!body || typeof body !== 'object') {
      return null;
    }

    const payload = body as { query?: unknown; sql?: unknown; prompt?: unknown };
    const query = typeof payload.query === 'string' ? payload.query.trim() : '';
    const sql = typeof payload.sql === 'string' ? payload.sql.trim() : '';
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';

    return query || sql || prompt || null;
  }

  /**
   * Normalizes an optional array of allowed statement names into query-language statement types.
   * @param value Raw request value.
   * @returns {QueryStatementType[] | null} Normalized allowed statements, or null when omitted.
   */
  normalizeAllowedStatements(value: unknown): QueryStatementType[] | null {
    if (value === undefined) {
      return null;
    }

    if (!Array.isArray(value)) {
      return [];
    }

    const allowedStatements: QueryStatementType[] = [];
    for (const statement of value) {
      if (typeof statement !== 'string') {
        continue;
      }

      if (statement === 'SELECT' || statement === 'INSERT' || statement === 'UPDATE' || statement === 'DELETE') {
        allowedStatements.push(statement as QueryStatementType);
      }
    }

    return allowedStatements;
  }

  /**
   * Executes a raw SQL query through the query-language interpreter.
   * @param query SQL text produced by the SQL endpoint.
   * @returns {Promise<unknown>} Interpreter execution result.
   */
  async executeSqlQuery(query: string, ids: string[] = [], userId: string = 'NO_USER'): Promise<unknown> {
    const interpreter = new Interpreter(query, this.getQueryLanguageStorageAdapter());
    return await Promise.resolve(interpreter.execute(ids, userId));
  }

  /**
   * Executes a natural-language prompt through the query-language natural-language executor.
   * @param body Parsed request body containing prompt and optional execution settings.
   * @returns {Promise<unknown>} Query execution result returned by the interpreter.
   */
  async executeNaturalLanguageQuery(body: Record<string, unknown>): Promise<unknown> {
    const prompt = this.extractQueryText(body);

    if (!prompt) {
      throw new Error('prompt is required');
    }

    const allowedStatements = this.normalizeAllowedStatements(body['allowedStatements']);
    const executor = new NaturalLanguageExecutor({
      storageAdapter: this.getQueryLanguageStorageAdapter(),
      model: typeof body['model'] === 'string' && body['model'].trim().length > 0 ? body['model'].trim() : undefined,
      schemaContext:
        typeof body['schemaContext'] === 'string' && body['schemaContext'].trim().length > 0
          ? body['schemaContext'].trim()
          : undefined,
      allowedStatements: allowedStatements && allowedStatements.length > 0 ? allowedStatements : undefined,
    });

    return await executor.executeNaturalLanguageQuery(prompt);
  }

  async NLtoSQL(body: Record<string, unknown>): Promise<unknown> {
    const prompt = this.extractQueryText(body);
    if (!prompt) {
      throw new Error('prompt is required');
    }
    const allowedStatements = this.normalizeAllowedStatements(body['allowedStatements']);
    const executor = new NaturalLanguageExecutor({
      storageAdapter: this.getQueryLanguageStorageAdapter(),
      model: typeof body['model'] === 'string' && body['model'].trim().length > 0 ? body['model'].trim() : undefined,
      schemaContext:
        typeof body['schemaContext'] === 'string' && body['schemaContext'].trim().length > 0
          ? body['schemaContext'].trim()
          : undefined,
      allowedStatements: allowedStatements && allowedStatements.length > 0 ? allowedStatements : undefined,
    });
    return await executor.NLtoSQL(prompt);
  }

  getHnswIndex(): hnswIndexImpl | undefined {
    return this.hnswIndex;
  }

  /*****************************************************

                          DEBUG

  /***************************************************** */
  public async debug_readHeader() {
    // Raw bytes/hexa -> decoded -> JSON
    const headerBuf = await this.fbFile.readHeader();
    const decodedHeader = decodeHeaderFromStorage(headerBuf);
    const parsedHeader = JSON.parse(decodedHeader) as typeof this.dbHeader;

    //
    return parsedHeader;
  }

  /**
   * Recursively builds the entire tree upon loading! Does NOT dynamically load in parts of the tree as needed.
   */
  public async debug_printOnDiskTreeSLOW(name: string) {
    if (!isDebugEnabled()) {
      return;
    }

    /**
     * If it is not an existing collection, print the catalogTree
     */
    const headerBuf = await this.fbFile.readHeader();
    const decodedHeader = decodeHeaderFromStorage(headerBuf);
    const parsedHeader = JSON.parse(decodedHeader) as typeof this.dbHeader;
    const collectionExists = Object.keys(parsedHeader['collections']).includes(name);

    if (collectionExists) {
      debugLog(`Loading primary index data for collection ${name}`);
      // [TODO] -> need to know the order of a tree to accurately display it...
      // for now, I hardcode it s.t. each collection has order = 10. (if this fails, go check if it wasn't changed in createCollection()!)
      const rootID: number = parsedHeader['collections'][name]['rootBlockId'];
      const rootNode = await this.catalogStorage.debug_recursivelyLoadTree(rootID);

      //
      const tree = new BPlusTree(this.catalogStorage, 10);
      await tree.init();
      tree.load(rootNode);

      //
      debugLog();
      debugLog();
      debugLog('[KEYS');
      debugLog();
      tree.asciiBlocks();

      debugLog();
      debugLog();
      debugLog('[NODE BLOCK IDS]');
      debugLog();
      tree.ascii();

      debugLog();
      debugLog();
      debugLog('[VALUES]');
      debugLog();
      tree.asciiValues();
    } else {
      /**
       * Collection doesn't exist, load catalog tree.
       */
      debugLog(`No collection with name '${name}' -> loading primary index data for catalog tree`);
      const rootNode = await this.catalogStorage.debug_recursivelyLoadTree(parsedHeader.catalogRootBlockId);

      const tree = new BPlusTree(this.catalogStorage, 3);
      await tree.init();
      tree.load(rootNode);

      //
      debugLog();
      debugLog();
      debugLog('[KEYS');
      debugLog();
      tree.asciiBlocks();

      debugLog();
      debugLog();
      debugLog('[NODE BLOCK IDS]');
      debugLog();
      tree.ascii();

      debugLog();
      debugLog();
      debugLog('[VALUES]');
      debugLog();
      tree.asciiValues();
    }
  }

  /**
   * Prints the currently loaded in-memory catalog tree using node block IDs.
   */
  public debug_printCatalogTreeNodeBlockIds(): void {
    if (!isDebugEnabled()) {
      return;
    }

    this.catalogTree.ascii();
  }

  /**
   * Prints the currently loaded in-memory catalog tree key layout.
   */
  public debug_printCatalogTreeKeys(): void {
    if (!isDebugEnabled()) {
      return;
    }

    this.catalogTree.asciiBlocks();
  }

  /**
   * Returns stats for the currently loaded in-memory catalog tree.
   */
  // public debug_catalogTreeStats() {
  //   return debug_treeStats(this.catalogTree);
  // }

  /**
   * Asserts invariants for the currently loaded in-memory catalog tree.
   */
  public debug_assertCatalogTreeInvariants(): void {
    if (!isDebugEnabled()) {
      return;
    }

    //debug_checkInvariants(this.catalogTree);
  }

  /***************************************************** 
   
                        FUNCTIONALITY 
  
  /***************************************************** */

  /**
   * Gets the FreeBlockFile instance.
   * @returns {FreeBlockFile} The FreeBlockFile instance.
   */
  public getFreeBlockFile(): FreeBlockFile {
    return this.fbFile;
  }

  /**
   * Creates a new database.
   * @param {File} file The file to use for the database index.
   * @param {File} walFile The file to use for the index write-ahead log.
   * @param {File} heapFile The file to use for the document heap storage.
   * @param {File} heapWalFile The file to use for the document heap write-ahead log.
   * @param {File} hnswFile The file used to store hnsw nodes on disk.
   * @param {File} hnswWalFile The file for the hnsw wal.
   * @param {File} hnswTreeFile The file used for the hnsw bplustree.
   * @param {File} hnswTreeWalFile The file for the hsnw bplustree wal.
   * @param {File} diskStorageWalFile The file used for the hnsw write-ahead log.
   * @returns {Promise<SimpleDBMS>} A new SimpleDBMS instance.
   * @throws {Error} If some but not all optional parameters are passed.
   */
  static async create(
    file: File,
    walFile: File,
    heapFile?: File,
    heapWalFile?: File,
    hnswFile?: File,
    hnswWalFile?: File,
    hnswTreeFile?: File,
    hnswTreeWalFile?: File,
    diskStorageWalFile?: File,
  ): Promise<SimpleDBMS> {
    const optionals = [hnswFile, hnswWalFile, hnswTreeFile, hnswTreeWalFile, diskStorageWalFile];
    const definedCount = optionals.filter((f) => f !== undefined).length;
    if (definedCount !== 0 && definedCount !== optionals.length) {
      throw new Error('Either all optional file parameters must be provided or none of them.');
    }

    // Allow callers to omit heap files (common in tests/compaction). If omitted,
    // default heapFile/heapWalFile to the index file/WAL so a single-file mock
    // setup still works.
    const resolvedHeapFile = heapFile ?? file;
    const resolvedHeapWalFile = heapWalFile ?? walFile;
    const shareStorage = resolvedHeapFile === file && resolvedHeapWalFile === walFile;

    const walManager = new WALManagerImpl(walFile, file);
    const atomicFile = new AtomicFileImpl(file, walManager);
    const fbFile = new FreeBlockFile(file, atomicFile, DEFAULT_BLOCK_SIZE);
    await fbFile.open();

    let documentHeap: FreeBlockFile;
    if (shareStorage) {
      documentHeap = fbFile;
    } else {
      const heapWalManager = new WALManagerImpl(resolvedHeapWalFile, resolvedHeapFile);
      const heapAtomicFile = new AtomicFileImpl(resolvedHeapFile, heapWalManager);
      documentHeap = new FreeBlockFile(resolvedHeapFile, heapAtomicFile, DEFAULT_BLOCK_SIZE);
      await documentHeap.open();
    }

    let db: SimpleDBMS;
    if (hnswFile === undefined) {
      db = new SimpleDBMS(fbFile, documentHeap);
    } else {
      const walManager1 = new WALManagerImpl(hnswWalFile!, hnswFile);
      const atomicFile1 = new AtomicFileImpl(hnswFile, walManager1);
      const fbFile1 = new FreeBlockFile(hnswFile, atomicFile1, 4096 * 4);
      await fbFile1.open();

      const walManager2 = new WALManagerImpl(hnswTreeWalFile!, hnswTreeFile!);
      const atomicFile2 = new AtomicFileImpl(hnswTreeFile!, walManager2);
      const fbFile2 = new FreeBlockFile(hnswTreeFile!, atomicFile2, 4096 * 4);
      await fbFile2.open();

      const hnsw: hnswIndexImpl = new hnswIndexImpl(4, 48, 96, 64, 64, fbFile1, fbFile2, diskStorageWalFile!);
      await hnsw.init();
      await hnsw.open();

      db = new SimpleDBMS(fbFile, documentHeap, hnsw);
    }

    await db.initCatalog(true);
    return db;
  }

  /**
   * Opens an existing database.
   * @param {File} file The file to use for the database index.
   * @param {File} walFile The file to use for the index write-ahead log.
   * @param {File} heapFile The file to use for the document heap storage.
   * @param {File} heapWalFile The file to use for the document heap write-ahead log.
   * @param {File} hnswFile The file used to store hnsw nodes on disk.
   * @param {File} hnswWalFile The file for the hnsw wal.
   * @param {File} hnswTreeFile The file used for the hnsw bplustree.
   * @param {File} hnswTreeWalFile The file for the hsnw bplustree wal.
   * @param {File} diskStorageWalFile The file used for the hnsw write-ahead log
   * @returns {Promise<SimpleDBMS>} A SimpleDBMS instance.
   * @throws {Error} If some but not all optional parameters are passed.
   */
  static async open(
    file: File,
    walFile: File,
    heapFile?: File,
    heapWalFile?: File,
    hnswFile?: File,
    hnswWalFile?: File,
    hnswTreeFile?: File,
    hnswTreeWalFile?: File,
    diskStorageWalFile?: File,
  ): Promise<SimpleDBMS> {
    const optionals = [hnswFile, hnswWalFile, hnswTreeFile, hnswTreeWalFile, diskStorageWalFile];
    const definedCount = optionals.filter((f) => f !== undefined).length;
    if (definedCount !== 0 && definedCount !== optionals.length) {
      throw new Error('Either all optional file parameters must be provided or none of them.');
    }

    const resolvedHeapFile = heapFile ?? file;
    const resolvedHeapWalFile = heapWalFile ?? walFile;
    const shareStorage = resolvedHeapFile === file && resolvedHeapWalFile === walFile;

    const walManager = new WALManagerImpl(walFile, file);
    const atomicFile = new AtomicFileImpl(file, walManager);
    await atomicFile.recover();
    const fbFile = new FreeBlockFile(file, atomicFile, DEFAULT_BLOCK_SIZE);
    await fbFile.open();

    let documentHeap: FreeBlockFile;
    if (shareStorage) {
      documentHeap = fbFile;
    } else {
      const heapWalManager = new WALManagerImpl(resolvedHeapWalFile, resolvedHeapFile);
      const heapAtomicFile = new AtomicFileImpl(resolvedHeapFile, heapWalManager);
      await heapAtomicFile.recover();
      documentHeap = new FreeBlockFile(resolvedHeapFile, heapAtomicFile, DEFAULT_BLOCK_SIZE);
      await documentHeap.open();
    }

    let db: SimpleDBMS;
    if (hnswFile === undefined) {
      db = new SimpleDBMS(fbFile, documentHeap);
    } else {
      const walManager1 = new WALManagerImpl(hnswWalFile!, hnswFile);
      const atomicFile1 = new AtomicFileImpl(hnswFile, walManager1);
      const fbFile1 = new FreeBlockFile(hnswFile, atomicFile1, 4096 * 4);
      await fbFile1.open();

      const walManager2 = new WALManagerImpl(hnswTreeWalFile!, hnswTreeFile!);
      const atomicFile2 = new AtomicFileImpl(hnswTreeFile!, walManager2);
      const fbFile2 = new FreeBlockFile(hnswTreeFile!, atomicFile2, 4096 * 4);
      await fbFile2.open();

      const hnsw: hnswIndexImpl = new hnswIndexImpl(4, 48, 96, 64, 64, fbFile1, fbFile2, diskStorageWalFile!);
      await hnsw.init();
      await hnsw.open();

      db = new SimpleDBMS(fbFile, documentHeap, hnsw);
    }

    await db.initCatalog(false);
    return db;
  }

  /**
   * Database header format for storing metadata.
   */
  private dbHeader: {
    catalogRootBlockId: number;
    collections: {
      [name: string]: {
        rootBlockId: number;
        indexes: { [field: string]: number };
        documentCount: number;
      };
    };
  } = { catalogRootBlockId: 0, collections: {} };

  private async initCatalog(isNew: boolean) {
    //[DEBUG]
    debugLog('[DEBUG] DB.initCatalog() -> triggers  0/1 saveCatalogRoot()');
    //
    this.catalogStorage = new FBNodeStorage<string, number>(
      (a, b) => (a < b ? -1 : a > b ? 1 : 0),
      (key) => key.length,
      this.fbFile,
      4096,
    );

    this.catalogTree = new BPlusTree(this.catalogStorage, 3);

    if (isNew) {
      // [DEBUG]
      debugLog('[DEBUG] new catalog tree!');
      //

      await this.catalogTree.init();
      await this.saveCatalogRoot();
    } else {
      const headerBuf = await this.fbFile.readHeader();
      if (headerBuf.length === 0) {
        //
        debugLog('[DEBUG] empty headerbuf!');
        //
        await this.catalogTree.init();
        await this.saveCatalogRoot();
      } else {
        try {
          // Remove null bytes before parsing
          const decodedHeader = decodeHeaderFromStorage(headerBuf);
          this.dbHeader = JSON.parse(decodedHeader) as typeof this.dbHeader;
          const rootNode = await this.catalogStorage.loadNode(this.dbHeader.catalogRootBlockId);
          this.catalogTree.load(rootNode);
          //
          debugLog(`[DEBUG] loaded catalogtree from disk!!`);
          debugLog(this.catalogTree);
          //
        } catch {
          const rootBlockId = headerBuf.readUInt32LE(0);
          this.dbHeader.catalogRootBlockId = rootBlockId;
          const rootNode = await this.catalogStorage.loadNode(rootBlockId);
          this.catalogTree.load(rootNode);
        }
      }
    }
  }

  /**
   * - Saves the root (and only the root) to disk
   * - Saves rootID of catalogTree to the Header Buffer
   *
   * Entire Catalog tree can be reconstructed by getting rootID from header buffer and following pointers (nextBlockID, childBlockIDs, nextLeaf...)
   */
  private async saveCatalogRoot() {
    // [DEBUG]
    debugLog(`[DEBUG] DB.saveCatalogRoot() - persisting root of catalog tree (goes to disk!)`);
    debug_incrementFnCallCount('saveCatalogRoot()');
    //

    const root = this.catalogTree.getRoot();
    let rootId: number;
    const previousID: number = this.dbHeader.catalogRootBlockId;

    if (root.isLeaf) {
      await this.catalogStorage.persistLeaf(root);
      rootId = root.blockId!;
    } else {
      await this.catalogStorage.persistInternal(root);
      rootId = root.blockId!;
    }

    this.dbHeader.catalogRootBlockId = rootId;

    /* Store new rootID, can subsequently get entire catalogTree by rootID and following pointers */
    if (previousID !== rootId) {
      await this.flushHeaderBuf();
    }
  }

  /**
   * Flushes (writes) header buffer to disk.
   */
  private async flushHeaderBuf() {
    // [DEBUG]
    debug_incrementFnCallCount('flushHeaderBuf()');
    //
    const headerBuf = encodeHeaderForStorage(this.dbHeader as unknown as Record<string, unknown>);
    await this.fbFile.writeHeader(headerBuf);

    if (this.catalogAutoCommitEnabled) {
      await this.fbFile.commit();
      await this.hnswIndex?.commitToWal();
    }
  }

  setCatalogAutoCommitEnabled(enabled: boolean): void {
    this.catalogAutoCommitEnabled = enabled;
  }

  async commit(): Promise<void> {
    if (this.documentHeap !== this.fbFile) {
      await this.documentHeap.commit();
    }
    await this.fbFile.commit();
    await this.hnswIndex?.commitToWal();
  }

  /**
   * Checkpoint all committed data to the database.
   */
  async checkpoint(): Promise<void> {
    if (this.documentHeap !== this.fbFile) {
      await this.documentHeap.checkpoint();
    }
    await this.fbFile.checkpoint();
  }

  /**
   * Creates a new collection.
   * @param {string} name The name of the collection to create.
   * @returns {Promise<Collection>} The newly created collection.
   */
  async createCollection(name: string): Promise<Collection> {
    // [DEBUG]
    debugLog(`creating collection ${name}`);
    //

    if (this.collections.has(name) || (await this.catalogTree.search(name)) !== null) {
      throw new Error(`Collection '${name}' already exists`);
    }

    const storage = new FBNodeStorage<string, number>(
      (a, b) => (a < b ? -1 : a > b ? 1 : 0),
      (key) => key.length,
      this.fbFile,
      4096,
    );

    //
    const ORDER = 10;
    const tree = new BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>(
      storage,
      ORDER,
    );
    //

    this.dbHeader.collections[name] = {
      rootBlockId: 0,
      indexes: {},
      documentCount: 0,
    };

    await tree.init();
    await this.saveCollectionRoot(name, tree, storage);

    const onChangeCallback = async () => {
      await this.saveCollectionRoot(name, tree, storage);
    };
    const createIndexStorage = () =>
      new FBNodeStorage<string, number>(
        (a, b) => (a < b ? -1 : a > b ? 1 : 0),
        () => 1024,
        this.fbFile,
        4096,
      );
    const onIndexCreated = async (indexes: Array<{ fieldName: string; rootBlockId: number }>) => {
      await this.saveIndexMetadata(name, indexes);
    };
    const onDocumentCountChanged = async (documentCount: number) => {
      await this.saveDocumentCountMetadata(name, documentCount);
    };
    const onIndexTreesCommitted = async () => {
      await this.fbFile.commit();
      await this.hnswIndex?.commitToWal();
    };
    const onIndexDropped = async (fieldName: string) => {
      await this.removeIndexMetadata(name, fieldName);
    };

    const collection = new Collection(
      this.documentHeap,
      tree,
      onChangeCallback,
      createIndexStorage,
      onIndexCreated,
      onDocumentCountChanged,
      onIndexTreesCommitted,
      0, // initialDocumentCount
      DEFAULT_SECONDARY_INDEX_ORDER,
      onIndexDropped,
      this.hnswIndex,
    );

    this.collections.set(name, collection);

    if (this.hnswIndex !== undefined) {
      this.hnswIndex.collection = collection;
    }

    return collection;
  }

  /**
   * Deletes given collection
   * @param {string} name The name of the collection to create.
   */
  async deleteCollection(name: string): Promise<void> {
    // [DEBUG]
    console.log(`deleting collection ${name}`);
    //
    const deleted = delete this.dbHeader.collections[name];
    if (!deleted) {
      throw new Error(`Delete failed: Collection ${name} was not in the dbHeader!`);
    }
    this.collections.delete(name);
    await this.catalogTree.delete(name);

    //
    await this.flushHeaderBuf();

    return;
  }

  /**
   * Returns the names of all collections stored in the database.
   */
  async getCollectionNames(): Promise<string[]> {
    const names: string[] = [];
    for await (const { key } of this.catalogTree.entries()) {
      names.push(key);
    }
    return names;
  }

  /**
   * Returns the indexed field names for a collection from the header metadata.
   */
  getCollectionIndexInfo(name: string): string[] {
    const meta = this.dbHeader.collections[name];
    if (!meta?.indexes) return [];
    return Object.keys(meta.indexes);
  }

  /**
   * Gets a collection.
   * @param {string} name The name of the collection.
   * @returns {Promise<Collection>} The collection.
   */
  async getCollection(name: string): Promise<Collection> {
    if (this.collections.has(name)) {
      return this.collections.get(name)!;
    }

    const rootBlockId = await this.catalogTree.search(name);

    if (rootBlockId === null) {
      throw new Error(`Collection '${name}' not found`);
    }

    const storage = new FBNodeStorage<string, number>(
      (a, b) => (a < b ? -1 : a > b ? 1 : 0),
      (key) => key.length,
      this.fbFile,
      4096,
    );
    const tree = new BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>(storage, 50);

    const rootNode = await storage.loadNode(rootBlockId);
    tree.load(rootNode);

    const collectionMeta = this.dbHeader.collections[name];

    const onChangeCallback = async () => {
      await this.saveCollectionRoot(name, tree, storage);
    };
    const createIndexStorage = () =>
      new FBNodeStorage<string, number>(
        (a, b) => (a < b ? -1 : a > b ? 1 : 0),
        () => 1024,
        this.fbFile,
        4096,
      );
    const onIndexCreated = async (indexes: Array<{ fieldName: string; rootBlockId: number }>) => {
      await this.saveIndexMetadata(name, indexes);
    };
    const onDocumentCountChanged = async (documentCount: number) => {
      await this.saveDocumentCountMetadata(name, documentCount);
    };
    const onIndexTreesCommitted = async () => {
      await this.fbFile.commit();
      await this.hnswIndex?.commitToWal();
    };
    const onIndexDropped = async (fieldName: string) => {
      await this.removeIndexMetadata(name, fieldName);
    };

    const collection = new Collection(
      this.documentHeap,
      tree,
      onChangeCallback,
      createIndexStorage,
      onIndexCreated,
      onDocumentCountChanged,
      onIndexTreesCommitted,
      0, // initialDocumentCount
      DEFAULT_SECONDARY_INDEX_ORDER,
      onIndexDropped,
      this.hnswIndex,
    );

    if (collectionMeta?.indexes !== undefined) {
      const indexMap = new Map<
        string,
        BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>
      >();

      for (const [field, indexRootId] of Object.entries(collectionMeta.indexes)) {
        const indexStorage = new FBNodeStorage<string, number>(
          (a, b) => (a < b ? -1 : a > b ? 1 : 0),
          () => 1024, // Estimated index key size (required by API but unused in capacity calculations)
          this.fbFile,
          4096,
        );
        const indexTree = new BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>(
          indexStorage,
          DEFAULT_SECONDARY_INDEX_ORDER,
        );

        const indexRootNode = await indexStorage.loadNode(indexRootId);
        indexTree.load(indexRootNode);

        indexMap.set(field, indexTree);
      }

      collection.setIndexes(indexMap);
    }

    this.collections.set(name, collection);
    return collection;
  }

  /**
   * Performs a natural join between two collections on a common field.
   * Uses hash join algorithm for O(n + m) performance.
   * @param {object} options The join options.
   * @param {string} options.leftCollection The left collection name.
   * @param {string} options.rightCollection The right collection name.
   * @param {string} options.on The field to join on for the left collection.
   * @param {string} [options.rightOn] The field to join on for the right collection (defaults to 'on').
   * @param {'inner' | 'left' | 'right'} [options.type='inner'] The type of join.
   * @returns {Promise<Document[]>} The joined documents.
   */
  async join(options: {
    leftCollection: string;
    rightCollection: string;
    on: string;
    rightOn?: string;
    type?: 'inner' | 'left' | 'right';
  }): Promise<Document[]> {
    const { leftCollection, rightCollection, on, rightOn = on, type = 'inner' } = options;

    const left = await this.getCollection(leftCollection);
    const right = await this.getCollection(rightCollection);

    const rightMap = new Map<DocumentValue, Document[]>();

    if (right.getIndexedFields().includes(rightOn)) {
      const indexTree = right.getIndex(rightOn);
      if (indexTree !== undefined) {
        for await (const { value: startBlockId } of indexTree.entries()) {
          const docBuffer = await right.getDocumentHeap().readBlob(startBlockId);
          if (docBuffer.length > 0) {
            const doc = JSON.parse(docBuffer.toString()) as Document;
            const key = doc[rightOn];
            if (!rightMap.has(key)) {
              rightMap.set(key, []);
            }
            rightMap.get(key)!.push(doc);
          }
        }
      }
    } else {
      const rightDocs = await right.find({});
      for (const doc of rightDocs) {
        const key = doc[rightOn];
        if (!rightMap.has(key)) {
          rightMap.set(key, []);
        }
        rightMap.get(key)!.push(doc);
      }
    }

    const results: Document[] = [];
    const leftDocs = await left.find({});
    for (const leftDoc of leftDocs) {
      const key = leftDoc[on];
      const rightDocs = rightMap.get(key);

      if (rightDocs !== undefined && rightDocs.length > 0) {
        for (const rightDoc of rightDocs) {
          const merged: Document = { ...leftDoc };
          for (const [field, value] of Object.entries(rightDoc)) {
            if (field === 'id' || field === rightOn) {
              continue;
            }

            if (field in leftDoc) {
              merged[`${rightCollection}_${field}`] = value;
            } else {
              merged[field] = value;
            }
          }
          results.push(merged);
        }
      } else if (type === 'left') {
        results.push({ ...leftDoc });
      }
    }

    return results;
  }

  /**
   * primary index of collection:
   * - Unconditionally persist the root node of this *this* collection.
   *
   * catalog tree:
   * - persists catalogTree if the root ID of an existing collection changes (to update value in leaves)!
   * - persist catalogTree is a new collection is added
   */
  private async saveCollectionRoot(
    name: string,
    tree: BPlusTree<string, number, FBLeafNode<string, number>, FBInternalNode<string, number>>,
    storage: FBNodeStorage<string, number>,
  ) {
    //[DEBUG]
    debugLog(`[DEBUG] saveCollectionRoot() [${name}] -> triggers 1 saveCatalogRoot()`);
    //

    /**************************************************
     *       primary tree of *this* collection        *
     *************************************************/
    const root = tree.getRoot();
    let rootId: number;

    if (root.isLeaf) {
      await storage.persistLeaf(root);
      rootId = root.blockId!;
    } else {
      await storage.persistInternal(root);
      rootId = root.blockId!;
    }

    /**************************************************
     *                 CATALOG TREE                   *
     *************************************************/

    if (this.dbHeader.collections[name] === undefined) {
      this.dbHeader.collections[name] = { rootBlockId: rootId, indexes: {}, documentCount: 0 };
      await this.flushHeaderBuf();
    } else {
      // id change -> update (K,V) pair in catalog tree + update headerBuf
      const previousID = this.dbHeader.collections[name].rootBlockId;
      if (previousID !== rootId) {
        //
        this.dbHeader.collections[name].rootBlockId = rootId;
        await this.flushHeaderBuf();
        await this.catalogTree.update(name, rootId);
      }
    }

    // new collection -> new (K,V) pair in catalog tree
    if ((await this.catalogTree.search(name)) === null) {
      await this.catalogTree.insert(name, rootId);
    }

    // Ensure catalog root is saved after collection/root changes
    await this.saveCatalogRoot();
  }

  /**
   * Saves index metadata for a collection.
   *
   * @param {string} collectionName The name of the collection.
   * @param {Array<{ fieldName: string; rootBlockId: number }>} indexes An array of index metadata objects, each containing the indexed field and the root block ID of the index tree.
   * @returns {Promise<void>} A promise that resolves when the metadata is saved.
   */
  async saveIndexMetadata(
    collectionName: string,
    indexes: Array<{ fieldName: string; rootBlockId: number }>,
  ): Promise<void> {
    //[DEBUG]
    debugLog(`[DEBUG] saveIndexMetaData() [${collectionName}] -> triggers 1 saveCatalogRoot()`);
    debug_incrementFnCallCount('saveIndexMetaData()');
    //
    if (this.dbHeader.collections[collectionName] === undefined) {
      this.dbHeader.collections[collectionName] = { rootBlockId: 0, indexes: {}, documentCount: 0 };
    }
    for (const { fieldName, rootBlockId } of indexes) {
      this.dbHeader.collections[collectionName].indexes[fieldName] = rootBlockId;
    }

    await this.flushHeaderBuf();
    await this.saveCatalogRoot();
  }

  async saveDocumentCountMetadata(collectionName: string, documentCount: number): Promise<void> {
    //[DEBUG]
    debugLog(`[DEBUG] saveDocumentCountMetaData() [${collectionName}] -> triggers 1 saveCatalogRoot()`);
    debug_incrementFnCallCount('saveDocumentCountMetaData()');
    //

    if (this.dbHeader.collections[collectionName] === undefined) {
      this.dbHeader.collections[collectionName] = { rootBlockId: 0, indexes: {}, documentCount: 0 };
    }
    this.dbHeader.collections[collectionName].documentCount = documentCount;

    await this.flushHeaderBuf();
    await this.saveCatalogRoot();
  }

  /**
   * Removes index metadata for a collection.
   * @param {string} collectionName The name of the collection.
   * @param {string} field The indexed field.
   * @returns {Promise<void>} A promise that resolves when the metadata is removed.
   */
  async removeIndexMetadata(collectionName: string, field: string): Promise<void> {
    //[DEBUG]
    debugLog(`[DEBUG] removeIndexMetaData() [${collectionName}] -> triggers 1 saveCatalogRoot()`);
    debug_incrementFnCallCount('removeIndexMetaData()');
    //
    if (this.dbHeader.collections[collectionName]?.indexes !== undefined) {
      delete this.dbHeader.collections[collectionName].indexes[field];

      await this.flushHeaderBuf();
      await this.saveCatalogRoot();
    }
  }

  /**
   * Closes the database.
   */
  async close() {
    await this.commit();
    await this.checkpoint();
    await this.fbFile.close();
    await this.hnswIndex?.close();
    if (this.documentHeap !== this.fbFile) {
      await this.documentHeap.close();
    }
  }
}
