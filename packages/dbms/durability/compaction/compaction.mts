// @author Wout Van Hemelrijck
// @date 2026-02-24
//
// Database compaction & space reclamation module.
//
// Two strategies for reclaiming wasted space:
//
// 1. compactDatabase — Streaming rebuild (similar to SQLite's VACUUM)
//    Creates a new database on temporary files, streams documents one-by-one
//    from old DB → new DB (O(1) memory), recreates secondary indexes, then
//    swaps temp files into the original location. Requires 2× disk space, so for 1TB DB, you need 1TB free to compact. Safe and robust, suitable for large databases.
//
// 2. shrinkDatabase — In-place space reclamation
//    Reclaims unused and orphaned blocks by relocating live blocks into free
//    slots, then truncating the file. Requires zero extra disk space. Works
//    in 4 phases:
//    a) Build block map (walk free list + all B+ trees)
//    b) Build relocation table (pair highest live blocks with lowest free slots)
//    c) Execute relocations (rewrite block ID references, stage, commit atomically)
//    d) Truncate file
//    The database must be closed and reopened after shrinking.

import { SimpleDBMS } from '../../core/simpledbms.mjs';
import { FBNodeStorage } from '../../storage/node-storage/fb-node-storage.mjs';
import { type File } from '../../storage/file/file.mjs';
import {
  FreeBlockFile,
  NO_BLOCK,
  NEXT_POINTER_SIZE,
  LENGTH_PREFIX_SIZE,
  FREE_LIST_HEAD_OFFSET,
  HEADER_LENGTH_OFFSET,
  HEADER_CLIENT_AREA_OFFSET,
} from '../../storage/freeblockfile.mjs';
import {
  CompressionService,
  NODE_STORAGE_COMPRESSED_PAYLOAD_MAGIC,
} from '../../durability/compression/compression.mjs';
import { deserializeCompressionEnvelope } from '../../durability/compression/envelope.mjs';
import assert from 'node:assert';

const HEADER_COMPRESSED_PAYLOAD_MAGIC = Buffer.from('DBH1', 'ascii');

/**
 * Result returned after a compaction operation.
 */
export interface CompactionResult {
  success: boolean;
  collectionsCompacted: number;
  totalDocuments: number;
  sizeBefore: number;
  sizeAfter: number;
}

/**
 * Lightweight metadata about a collection (no document data in memory).
 */
interface CollectionMeta {
  name: string;
  indexedFields: string[];
}

/**
 * Gathers collection names and index metadata from the database.
 * This does NOT load any documents into memory.
 *
 * @param {SimpleDBMS} db - The open database instance.
 * @returns {Promise<CollectionMeta[]>} Metadata for each collection.
 */
async function gatherCollectionMeta(db: SimpleDBMS): Promise<CollectionMeta[]> {
  const collectionNames = await db.getCollectionNames();
  const metas: CollectionMeta[] = [];

  for (const name of collectionNames) {
    const collection = await db.getCollection(name);
    const loadedFields = collection.getIndexedFields();
    const headerFields = db.getCollectionIndexInfo(name);
    const indexedFields = [...new Set([...loadedFields, ...headerFields])];

    metas.push({ name, indexedFields });
  }

  return metas;
}

/**
 * Compacts a database using a streaming rebuild strategy.
 *
 * Documents are streamed one-by-one from the old database into a fresh one,
 * so memory usage is O(1) regardless of database size. This makes it suitable
 * for databases up to 1 TB and beyond.
 *
 * This is a blocking maintenance operation: the old database is closed during
 * compaction. The caller MUST ensure no other operations are in progress.
 * Unlike shrinkDatabase, this does not corrupt the old file (the old DB is
 * read-only during the streaming phase), but concurrent writes to the old DB
 * after the per-collection stream has begun will be silently absent from the
 * new database. Quiesce traffic before calling.
 *
 * @param {SimpleDBMS} db - The current database instance (will be closed).
 * @param {File} dbFile - The database file (will be recreated).
 * @param {File} walFile - The WAL file (will be recreated).
 * @param {File} [tempDbFile] - Optional temporary file for the new DB. If not
 *   provided, dbFile is reused after closing (suitable for MockFile in tests).
 * @param {File} [tempWalFile] - Optional temporary WAL file. If not provided,
 *   walFile is reused after closing.
 * @returns {Promise<{db: SimpleDBMS; result: CompactionResult}>} The new database instance and compaction stats.
 */
export async function compactDatabase(
  db: SimpleDBMS,
  dbFile: File,
  walFile: File,
  tempDbFile?: File,
  tempWalFile?: File,
  heapFile?: File,
  heapWalFile?: File,
  tempHeapFile?: File,
  tempHeapWalFile?: File,
): Promise<{ db: SimpleDBMS; result: CompactionResult }> {
  // Step 1: Gather metadata (collection names + index info) — no documents in memory
  const metas = await gatherCollectionMeta(db);

  // Step 2: Measure file size before compaction
  const sizeBefore = (await dbFile.stat()).size;

  // Step 3: Determine which files to build the new DB on
  const useTempFiles = tempDbFile !== undefined && tempWalFile !== undefined;
  const targetDbFile = useTempFiles ? tempDbFile : dbFile;
  const targetWalFile = useTempFiles ? tempWalFile : walFile;
  const useSeparateHeapFiles = heapFile !== undefined && heapWalFile !== undefined;
  const useTempHeapFiles =
    useTempFiles && useSeparateHeapFiles && tempHeapFile !== undefined && tempHeapWalFile !== undefined;
  const targetHeapFile = useSeparateHeapFiles ? (useTempHeapFiles ? tempHeapFile : heapFile) : undefined;
  const targetHeapWalFile = useSeparateHeapFiles ? (useTempHeapFiles ? tempHeapWalFile : heapWalFile) : undefined;

  if (useTempFiles && useSeparateHeapFiles && !useTempHeapFiles) {
    throw new Error('Temporary heap files must be provided when rebuilding a database with separate heap storage.');
  }

  if (useTempFiles) {
    // Create fresh temp files while old DB is still open for reading
    await targetDbFile.create();
    await targetDbFile.close();
    await targetWalFile.create();
    await targetWalFile.close();
    if (useTempHeapFiles) {
      await targetHeapFile!.create();
      await targetHeapFile!.close();
      await targetHeapWalFile!.create();
      await targetHeapWalFile!.close();
    }
  }

  // Step 4: Create the new (empty) database on temp files
  // If using same files, we need to stream into memory first for that collection,
  // so we use temp files when available. When not available (MockFile tests),
  // we close old DB first, then rebuild.
  let newDb: SimpleDBMS | undefined;
  let totalDocuments = 0;

  if (useTempFiles) {
    // Streaming mode: old DB stays open while we write to temp files
    newDb = await SimpleDBMS.create(targetDbFile, targetWalFile, targetHeapFile, targetHeapWalFile);

    try {
      for (const meta of metas) {
        const oldCollection = await db.getCollection(meta.name);
        const newCollection = await newDb.createCollection(meta.name);
        newCollection.setAutoCreateSecondaryIndexesOnInsert(false);

        // Stream documents one at a time — O(1) memory
        for await (const { value: doc } of oldCollection.entries()) {
          await newCollection.insert(doc);
          totalDocuments++;
        }

        // Recreate secondary indexes (createIndex already streams internally)
        for (const field of meta.indexedFields) {
          const indexStorage = new FBNodeStorage<string, number>(
            (a, b) => (a < b ? -1 : a > b ? 1 : 0),
            () => 1024,
            newDb.getFreeBlockFile(),
            4096,
          );
          await newCollection.createIndex(field, indexStorage);
        }
      }
    } catch (error) {
      // New DB build failed — old DB is still open and valid, just clean up temp
      await newDb.close();
      throw error;
    }

    // New DB is fully built — only now close the old one.
    // If close() fails, the new DB is still valid so we proceed.
    try {
      await db.close();
    } catch {
      // Old DB close failed, but new DB is ready — safe to continue
    }
  } else {
    // Fallback for same-file mode (MockFile tests):
    // We must collect documents per-collection since we can't read and write
    // the same file simultaneously. We still stream collection-by-collection
    // to limit peak memory to the largest single collection.
    const collectionDocs: { meta: CollectionMeta; docs: import('../../core/simpledbms.mjs').Document[] }[] = [];

    for (const meta of metas) {
      const oldCollection = await db.getCollection(meta.name);
      const docs: import('../../core/simpledbms.mjs').Document[] = [];
      for await (const { value: doc } of oldCollection.entries()) {
        docs.push(doc);
      }
      collectionDocs.push({ meta, docs });
    }

    // Close old DB and reset files — point of no return
    await db.close();
    await dbFile.create();
    await dbFile.close();
    await walFile.create();
    await walFile.close();

    // Rebuild — if this fails, we must still return a valid (empty) DB
    try {
      newDb = await SimpleDBMS.create(dbFile, walFile, heapFile, heapWalFile);

      for (const { meta, docs } of collectionDocs) {
        const newCollection = await newDb.createCollection(meta.name);
        newCollection.setAutoCreateSecondaryIndexesOnInsert(false);

        for (const doc of docs) {
          await newCollection.insert(doc);
          totalDocuments++;
        }

        for (const field of meta.indexedFields) {
          const indexStorage = new FBNodeStorage<string, number>(
            (a, b) => (a < b ? -1 : a > b ? 1 : 0),
            () => 1024,
            newDb.getFreeBlockFile(),
            4096,
          );
          await newCollection.createIndex(field, indexStorage);
        }
      }
    } catch {
      // Rebuild failed after destroying original files — recover with empty DB
      if (newDb) {
        try {
          await newDb.close();
        } catch {
          /* best effort */
        }
      }
      await dbFile.create();
      await dbFile.close();
      await walFile.create();
      await walFile.close();
      newDb = await SimpleDBMS.create(dbFile, walFile);

      const sizeAfter = (await targetDbFile.stat()).size;
      return {
        db: newDb,
        result: {
          success: false,
          collectionsCompacted: 0,
          totalDocuments: 0,
          sizeBefore,
          sizeAfter,
        },
      };
    }
  }

  // Step 5: Measure file size after compaction
  const sizeAfter = (await targetDbFile.stat()).size;
  assert(sizeAfter <= sizeBefore);

  return {
    db: newDb,
    result: {
      success: true,
      collectionsCompacted: metas.length,
      totalDocuments,
      sizeBefore,
      sizeAfter,
    },
  };
}

/**
 * Result returned after a shrink (space reclamation) operation.
 */
export interface ShrinkResult {
  success: boolean;
  blocksTotal: number;
  blocksFree: number;
  blocksRelocated: number;
  sizeBefore: number;
  sizeAfter: number;
}

/** Tree kind used to distinguish which leaf values contain block IDs. */
const enum TreeKind {
  CATALOG,
  COLLECTION,
  INDEX,
}

/** Metadata for one blob (one B+ tree node). */
interface BlobInfo {
  startBlockId: number;
  chain: number[];
  kind: 'node' | 'document';
  treeKind: TreeKind;
  /** Decoded B+ tree node JSON (keys/values/childBlockIds), captured during the walk for inspection. */
  nodeJson?: unknown;
}

/** Human-readable classification for a single block, used by inspection tooling. */
export type BlockKind = 'header' | 'free' | 'orphan' | 'catalog' | 'collection' | 'index' | 'document';

/** Parsed block-0 header that maps the on-disk B+ tree roots. */
interface DatabaseHeader {
  catalogRootBlockId: number;
  collections: { [name: string]: { rootBlockId: number; indexes: { [field: string]: number } } };
}

/**
 * Read-only block map of a FreeBlockFile. This is exactly the view
 * {@link shrinkDatabase} builds in its Phase 1 — exposed separately so demo and
 * inspection tooling can show precisely which blocks shrink would reclaim and
 * relocate, without ever mutating the file.
 */
export interface FreeBlockFileBlockMap {
  totalBlocks: number;
  /** Per-block live/free status; array index === block id. */
  blockStatus: Array<'FREE' | 'LIVE' | undefined>;
  /** Human-readable kind per block; array index === block id. */
  blockKind: BlockKind[];
  /** Block ids in free-list order (the linked list of holes). */
  freeListIds: number[];
  /** Every reclaimable block: free-list blocks PLUS orphaned (unreachable) blocks. */
  freeBlockIds: Set<number>;
  /** One entry per live blob (B+ tree node chain or document chain). */
  blobInfos: BlobInfo[];
  /** Parsed block-0 header (B+ tree roots), or null when block 0 holds no header. */
  header: DatabaseHeader | null;
  /** False when block 0 holds no header (empty DB); the tree walk is then skipped. */
  headerPresent: boolean;
}

/**
 * Walks a FreeBlockFile and classifies every block exactly as
 * {@link shrinkDatabase} does internally: free-list blocks, live B+ tree nodes
 * (catalog / collection / secondary index), live document blobs, and orphaned
 * blocks that were abandoned without being returned to the free list.
 *
 * Purely read-only — it stages no writes and never truncates. `shrinkDatabase`
 * delegates its Phase 1 to this function so the inspection view and the real
 * relocation always agree on which blocks are reclaimable.
 *
 * @param {FreeBlockFile} fbf - The open FreeBlockFile to inspect.
 * @returns {Promise<FreeBlockFileBlockMap>} The classified block map.
 */
export async function buildBlockMap(fbf: FreeBlockFile): Promise<FreeBlockFileBlockMap> {
  const totalBlocks = await fbf.getTotalBlockCount();
  const nodeCompressionService = new CompressionService();

  const blockStatus = new Array<'FREE' | 'LIVE' | undefined>(totalBlocks);
  const blockKind = new Array<BlockKind>(totalBlocks);
  const freeBlockIds = new Set<number>();
  const freeListIds: number[] = [];
  const blobInfos: BlobInfo[] = [];

  if (totalBlocks <= 1) {
    if (totalBlocks === 1) blockKind[0] = 'header';
    return { totalBlocks, blockStatus, blockKind, freeListIds, freeBlockIds, blobInfos, header: null, headerPresent: false };
  }

  // 1a: Walk the free list (the explicit linked list of holes)
  let freeHead = await fbf.debug_getFreeListHead();
  while (freeHead !== NO_BLOCK && freeHead < totalBlocks) {
    freeBlockIds.add(freeHead);
    freeListIds.push(freeHead);
    blockStatus[freeHead] = 'FREE';
    const block = await fbf.readRawBlock(freeHead);
    freeHead = block.readUInt32LE(0);
  }

  // 1b: Parse header JSON from block 0
  const headerBuf = await fbf.readHeader();
  if (headerBuf.length === 0) {
    blockKind[0] = 'header';
    for (const id of freeListIds) blockKind[id] = 'free';
    return { totalBlocks, blockStatus, blockKind, freeListIds, freeBlockIds, blobInfos, header: null, headerPresent: false };
  }

  let headerJsonBuf = headerBuf;
  const headerCompressed = deserializeCompressionEnvelope(headerBuf, HEADER_COMPRESSED_PAYLOAD_MAGIC);
  if (headerCompressed !== null) {
    const headerCompressionService = new CompressionService();
    headerJsonBuf = headerCompressionService.decompress(headerCompressed);
  }

  const header = JSON.parse(headerJsonBuf.toString()) as DatabaseHeader;

  async function readBlobChain(startBlockId: number): Promise<number[]> {
    const chain: number[] = [startBlockId];
    let cur = startBlockId;
    for (;;) {
      const block = await fbf.readRawBlock(cur);
      const next = block.readUInt32LE(0);
      if (next === NO_BLOCK) break;
      chain.push(next);
      cur = next;
    }
    return chain;
  }

  async function markDocumentBlob(startBlockId: number): Promise<void> {
    if (startBlockId === NO_BLOCK || startBlockId >= totalBlocks) return;
    if (blockStatus[startBlockId] === 'LIVE') return;
    const chain = await readBlobChain(startBlockId);
    for (const blockId of chain) blockStatus[blockId] = 'LIVE';
    blobInfos.push({ startBlockId, chain, kind: 'document', treeKind: TreeKind.COLLECTION });
  }

  function readBlobDataFromParts(parts: Buffer[]): Buffer {
    const full = Buffer.concat(parts);
    if (full.length < LENGTH_PREFIX_SIZE) return Buffer.alloc(0);
    const len = Number(full.readBigUInt64LE(0));
    return Buffer.from(full.slice(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + len));
  }

  async function walkTree(rootBlockId: number, treeKind: TreeKind): Promise<void> {
    if (rootBlockId === NO_BLOCK || rootBlockId >= totalBlocks) return;
    if (blockStatus[rootBlockId] === 'LIVE') return;

    const chain = await readBlobChain(rootBlockId);
    for (const blockId of chain) blockStatus[blockId] = 'LIVE';
    const info: BlobInfo = { startBlockId: rootBlockId, chain, kind: 'node', treeKind };
    blobInfos.push(info);

    const parts: Buffer[] = [];
    for (const blockId of chain) {
      const block = await fbf.readRawBlock(blockId);
      parts.push(Buffer.from(block.slice(NEXT_POINTER_SIZE)));
    }
    const data = readBlobDataFromParts(parts);
    if (data.length === 0) return;

    const decodedFBC1 = fbf.decodePayload(data);
    const nodeCompResult = deserializeCompressionEnvelope(decodedFBC1, NODE_STORAGE_COMPRESSED_PAYLOAD_MAGIC);
    const jsonBuf = nodeCompResult !== null ? nodeCompressionService.decompress(nodeCompResult) : decodedFBC1;

    const node = JSON.parse(jsonBuf.toString('utf-8')) as {
      type: string;
      childBlockIds?: number[];
      values?: Array<{ t?: string; value?: unknown }>;
    };
    info.nodeJson = node; // captured for read-only inspection (ignored by shrink)

    if (node.type === 'internal' && Array.isArray(node.childBlockIds)) {
      for (const childId of node.childBlockIds) {
        if (typeof childId === 'number' && childId !== NO_BLOCK) await walkTree(childId, treeKind);
      }
    } else if (node.type === 'leaf') {
      if (treeKind === TreeKind.CATALOG) {
        if (Array.isArray(node.values)) {
          for (const val of node.values) {
            const blockId =
              val && typeof val === 'object' && val.t === 'number' && typeof val.value === 'number'
                ? val.value
                : undefined;
            if (typeof blockId === 'number' && blockId !== NO_BLOCK) await walkTree(blockId, TreeKind.COLLECTION);
          }
        }
      } else if (Array.isArray(node.values)) {
        for (const val of node.values) {
          const blockId =
            val && typeof val === 'object' && val.t === 'number' && typeof val.value === 'number'
              ? val.value
              : undefined;
          if (typeof blockId === 'number' && blockId !== NO_BLOCK) await markDocumentBlob(blockId);
        }
      }
    }
  }

  await walkTree(header.catalogRootBlockId, TreeKind.CATALOG);
  for (const collMeta of Object.values(header.collections)) {
    for (const indexRootBlockId of Object.values(collMeta.indexes)) {
      if (typeof indexRootBlockId === 'number' && indexRootBlockId !== NO_BLOCK) {
        await walkTree(indexRootBlockId, TreeKind.INDEX);
      }
    }
  }

  // Any unvisited block is an orphan → shrink treats it as reclaimable.
  const orphanIds: number[] = [];
  for (let i = 1; i < totalBlocks; i++) {
    if (blockStatus[i] === undefined) {
      freeBlockIds.add(i);
      blockStatus[i] = 'FREE';
      orphanIds.push(i);
    }
  }

  // Compute human-readable kinds (header → live blobs → free list → orphans).
  blockKind[0] = 'header';
  const treeKindLabel: Record<TreeKind, BlockKind> = {
    [TreeKind.CATALOG]: 'catalog',
    [TreeKind.COLLECTION]: 'collection',
    [TreeKind.INDEX]: 'index',
  };
  for (const info of blobInfos) {
    const label: BlockKind = info.kind === 'document' ? 'document' : treeKindLabel[info.treeKind];
    for (const blockId of info.chain) blockKind[blockId] = label;
  }
  for (const id of freeListIds) blockKind[id] = 'free';
  for (const id of orphanIds) blockKind[id] = 'orphan';

  return { totalBlocks, blockStatus, blockKind, freeListIds, freeBlockIds, blobInfos, header, headerPresent: true };
}

/** Decoded contents of one live B+ tree node block, for inspection tooling. */
export interface DecodedNodeBlock {
  /** Block ids the node's blob spans (usually one). */
  chain: number[];
  /** 'catalog' | 'primary index' | 'secondary index'. */
  tree: string;
  /** Indexed field name, for secondary-index nodes. */
  field?: string;
  /** 'leaf' | 'internal'. */
  nodeType: string;
  /** Decoded keys (docIds, field values, or collection names). */
  keys: unknown[];
  /** Decoded values, leaf nodes only (heap block ids / collection roots). */
  values?: unknown[];
  /** Child block ids, internal nodes only. */
  childBlockIds?: number[];
  nextLeafBlockId?: number;
  prevLeafBlockId?: number;
}

/**
 * Read-only decode of every live B+ tree node in the index file, keyed by the
 * block where the node's blob starts. Unlike {@link buildBlockMap}, this walks
 * ONLY the real B+ trees from the header roots (catalog → each collection's
 * primary index → its secondary indexes) and never interprets leaf values as
 * in-file document blobs. That makes it the accurate source for "what is stored
 * in this block" — including nodes that shrink's relocation walk would otherwise
 * mis-tag as document blobs in separate-heap setups.
 *
 * Purely read-only; stages no writes.
 *
 * @param {FreeBlockFile} fbf - The open FreeBlockFile to inspect.
 * @returns {Promise<Map<number, DecodedNodeBlock>>} Decoded node per starting block id.
 */
export async function inspectIndexContents(fbf: FreeBlockFile): Promise<Map<number, DecodedNodeBlock>> {
  const out = new Map<number, DecodedNodeBlock>();
  const totalBlocks = await fbf.getTotalBlockCount();
  if (totalBlocks <= 1) return out;

  const headerBuf = await fbf.readHeader();
  if (headerBuf.length === 0) return out;
  let headerJsonBuf = headerBuf;
  const headerCompressed = deserializeCompressionEnvelope(headerBuf, HEADER_COMPRESSED_PAYLOAD_MAGIC);
  if (headerCompressed !== null) {
    headerJsonBuf = new CompressionService().decompress(headerCompressed);
  }
  const header = JSON.parse(headerJsonBuf.toString()) as DatabaseHeader;
  const svc = new CompressionService();
  const visited = new Set<number>();

  const decKey = (k: unknown): unknown =>
    k && typeof k === 'object' && 'value' in (k as Record<string, unknown>) ? (k as { value: unknown }).value : k;
  const decVal = (v: unknown): unknown => {
    if (!v || typeof v !== 'object') return v;
    const o = v as { t?: string; value?: unknown };
    if (o.t === 'json' && typeof o.value === 'string') {
      try {
        return JSON.parse(o.value);
      } catch {
        return o.value;
      }
    }
    return 'value' in o ? o.value : v;
  };

  async function readChain(startBlockId: number): Promise<number[]> {
    const chain = [startBlockId];
    let cur = startBlockId;
    while (chain.length <= totalBlocks) {
      const block = await fbf.readRawBlock(cur);
      const next = block.readUInt32LE(0);
      if (next === NO_BLOCK || next >= totalBlocks) break;
      chain.push(next);
      cur = next;
    }
    return chain;
  }

  async function walk(rootBlockId: number, tree: string, field?: string): Promise<void> {
    if (rootBlockId === NO_BLOCK || rootBlockId >= totalBlocks || visited.has(rootBlockId)) return;
    visited.add(rootBlockId);

    const chain = await readChain(rootBlockId);
    const parts: Buffer[] = [];
    for (const id of chain) {
      const block = await fbf.readRawBlock(id);
      parts.push(Buffer.from(block.slice(NEXT_POINTER_SIZE)));
    }
    const full = Buffer.concat(parts);
    if (full.length < LENGTH_PREFIX_SIZE) return;
    const len = Number(full.readBigUInt64LE(0));
    const data = Buffer.from(full.slice(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + len));

    const decodedFBC1 = fbf.decodePayload(data);
    const nodeComp = deserializeCompressionEnvelope(decodedFBC1, NODE_STORAGE_COMPRESSED_PAYLOAD_MAGIC);
    const jsonBuf = nodeComp !== null ? svc.decompress(nodeComp) : decodedFBC1;

    let node: {
      type?: string;
      keys?: unknown[];
      values?: unknown[];
      childBlockIds?: number[];
      nextBlockId?: number;
      prevBlockId?: number;
    };
    try {
      node = JSON.parse(jsonBuf.toString('utf-8'));
    } catch {
      return;
    }

    const decoded: DecodedNodeBlock = {
      chain,
      tree,
      field,
      nodeType: node.type ?? 'unknown',
      keys: Array.isArray(node.keys) ? node.keys.map(decKey) : [],
    };
    if (node.type === 'leaf') {
      decoded.values = Array.isArray(node.values) ? node.values.map(decVal) : [];
      decoded.nextLeafBlockId = node.nextBlockId;
      decoded.prevLeafBlockId = node.prevBlockId;
    } else if (node.type === 'internal') {
      decoded.childBlockIds = Array.isArray(node.childBlockIds) ? node.childBlockIds : [];
    }
    out.set(rootBlockId, decoded);

    if (node.type === 'internal' && Array.isArray(node.childBlockIds)) {
      for (const childId of node.childBlockIds) {
        if (typeof childId === 'number') await walk(childId, tree, field);
      }
    } else if (node.type === 'leaf' && tree === 'catalog' && Array.isArray(node.values)) {
      // Catalog leaf values are collection root block ids — recurse into each
      // collection's primary index so its leaves are decoded too.
      for (const val of node.values) {
        const rootId = decVal(val);
        if (typeof rootId === 'number' && rootId !== NO_BLOCK) await walk(rootId, 'primary index');
      }
    }
  }

  await walk(header.catalogRootBlockId, 'catalog');
  for (const [, collMeta] of Object.entries(header.collections)) {
    await walk(collMeta.rootBlockId, 'primary index');
    for (const [field, indexRoot] of Object.entries(collMeta.indexes)) {
      if (typeof indexRoot === 'number') await walk(indexRoot, 'secondary index', field);
    }
  }
  return out;
}

/**
 * Shrinks a database file in-place by reclaiming free and orphaned blocks.
 * Relocates live blocks into free slots at lower offsets, then truncates the
 * file. Requires zero extra disk space.
 *
 * The database must be closed and reopened after this function returns,
 * because in-memory caches hold stale block IDs.
 *
 * **Concurrency precondition.** This function does not perform any locking.
 * The caller MUST guarantee that no other operation touches the same
 * FreeBlockFile (insert / update / delete on any collection, secondary index
 * mutation, or another concurrent shrink) for the entire duration of this
 * call. Violating the precondition produces undefined behavior including
 * silent data corruption:
 *   - Phase 1 walks the B+ trees off-disk; blocks allocated by a concurrent
 *     INSERT after the walk completes are absent from the relocation table.
 *   - Phase 3 stages writes into the same `fbf.stagedWrites` map a concurrent
 *     INSERT is staging into, then `fbf.commit()` flushes both together — the
 *     insert's blocks end up at locations shrink has already remapped, and
 *     the freshly rewritten header advertises `freeListHead = NO_BLOCK`,
 *     which orphans every block the insert allocated.
 *   - Phase 4 truncates to the live-block count derived from the stale view,
 *     lopping off any blocks the insert appended past that boundary.
 *
 * Enforce the precondition by quiescing all DB traffic before calling (the
 * manual `/db/demo/shrink` endpoint relies on this), or by holding an
 * application-level write mutex exclusively across the call (see
 * `AutoCompactionCallbacks.runExclusively`).
 *
 * @param {FreeBlockFile} fbf - The open FreeBlockFile to shrink.
 * @returns {Promise<ShrinkResult>} Statistics about the shrink operation.
 */
export async function shrinkDatabase(fbf: FreeBlockFile): Promise<ShrinkResult> {
  const blockSize = fbf.blockSize;
  const payloadSize = fbf.payloadSize;
  const totalBlocks = await fbf.getTotalBlockCount();
  const file = fbf.getFile();
  const sizeBefore = (await file.stat()).size;

  // Trivial case: empty or header-only file
  if (totalBlocks <= 1) {
    return {
      success: true,
      blocksTotal: totalBlocks,
      blocksFree: 0,
      blocksRelocated: 0,
      sizeBefore,
      sizeAfter: sizeBefore,
    };
  }

  // ── Phase 1: Build Block Map ──────────────────────────────────────────
  // Delegated to buildBlockMap so the read-only inspection view (used by the
  // compaction demo) and the real relocation below always classify blocks
  // identically: free-list holes, live B+ tree nodes, and orphaned blocks.
  const map = await buildBlockMap(fbf);
  const { blockStatus, freeBlockIds, blobInfos, header } = map;

  // Header-less file: nothing reachable to relocate.
  if (!map.headerPresent) {
    return {
      success: true,
      blocksTotal: totalBlocks,
      blocksFree: freeBlockIds.size,
      blocksRelocated: 0,
      sizeBefore,
      sizeAfter: sizeBefore,
    };
  }
  assert(header !== null); // headerPresent === true guarantees a parsed header

  const blocksFree = freeBlockIds.size;
  if (blocksFree === 0) {
    return {
      success: true,
      blocksTotal: totalBlocks,
      blocksFree: 0,
      blocksRelocated: 0,
      sizeBefore,
      sizeAfter: sizeBefore,
    };
  }

  // Reused below in Phase 3 to decode node payloads when rewriting block IDs.
  const nodeCompressionService = new CompressionService();
  function readBlobDataFromParts(parts: Buffer[]): Buffer {
    const full = Buffer.concat(parts);
    if (full.length < LENGTH_PREFIX_SIZE) return Buffer.alloc(0);
    const len = Number(full.readBigUInt64LE(0));
    return Buffer.from(full.slice(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + len));
  }

  // ── Phase 2: Build Relocation Table ───────────────────────────────────

  const freeSorted = [...freeBlockIds].sort((a, b) => a - b);
  const liveSorted: number[] = [];
  for (let i = totalBlocks - 1; i >= 1; i--) {
    if (blockStatus[i] === 'LIVE') liveSorted.push(i);
  }

  const relocationMap = new Map<number, number>();
  let fi = 0;
  let li = 0;
  while (fi < freeSorted.length && li < liveSorted.length) {
    const freeSlot = freeSorted[fi];
    const liveBlock = liveSorted[li];
    if (liveBlock > freeSlot) {
      relocationMap.set(liveBlock, freeSlot);
      fi++;
      li++;
    } else {
      break;
    }
  }

  const relocated = (blockId: number): number => relocationMap.get(blockId) ?? blockId;

  // ── Phase 3: Execute Relocations ──────────────────────────────────────

  for (const blobInfo of blobInfos) {
    const { chain, treeKind, kind } = blobInfo;

    // Read raw blocks for this blob
    const rawBlocks: Buffer[] = [];
    const payloadParts: Buffer[] = [];
    for (const blockId of chain) {
      const block = await fbf.readRawBlock(blockId);
      rawBlocks.push(block);
      payloadParts.push(Buffer.from(block.slice(NEXT_POINTER_SIZE)));
    }
    const data = readBlobDataFromParts(payloadParts);
    if (data.length === 0) continue;

    // Decode FBC1 + ZST1 wrappers before parsing node JSON
    const decodedFBC1Phase3 = fbf.decodePayload(data);
    const nodeCompResultPhase3 = deserializeCompressionEnvelope(
      decodedFBC1Phase3,
      NODE_STORAGE_COMPRESSED_PAYLOAD_MAGIC,
    );
    const jsonBufPhase3 =
      nodeCompResultPhase3 !== null ? nodeCompressionService.decompress(nodeCompResultPhase3) : decodedFBC1Phase3;

    if (kind === 'document') {
      // Document blobs have no tree JSON; copy their raw block chain and update next pointers if needed.
      const chainMoved = chain.some((id) => relocationMap.has(id));
      if (!chainMoved) continue;

      for (let i = 0; i < chain.length; i++) {
        const newBlockId = relocated(chain[i]);
        const nextNewBlockId = i + 1 < chain.length ? relocated(chain[i + 1]) : NO_BLOCK;

        const block = Buffer.from(rawBlocks[i]);
        block.writeUInt32LE(nextNewBlockId >>> 0, 0);
        await fbf.stageRawBlock(newBlockId, block);
      }

      continue;
    }

    // Parse node JSON and apply relocations to block ID references
    const node = JSON.parse(jsonBufPhase3.toString('utf-8')) as Record<string, unknown>;
    let jsonChanged = false;

    if (node['type'] === 'internal') {
      const childBlockIds = node['childBlockIds'] as number[];
      if (Array.isArray(childBlockIds)) {
        for (let i = 0; i < childBlockIds.length; i++) {
          const newId = relocated(childBlockIds[i]);
          if (newId !== childBlockIds[i]) {
            childBlockIds[i] = newId;
            jsonChanged = true;
          }
        }
      }
    } else if (node['type'] === 'leaf') {
      // Update sibling pointers
      const nextId = node['nextBlockId'] as number | undefined;
      if (typeof nextId === 'number' && nextId !== NO_BLOCK) {
        const newId = relocated(nextId);
        if (newId !== nextId) {
          node['nextBlockId'] = newId;
          jsonChanged = true;
        }
      }
      const prevId = node['prevBlockId'] as number | undefined;
      if (typeof prevId === 'number' && prevId !== NO_BLOCK) {
        const newId = relocated(prevId);
        if (newId !== prevId) {
          node['prevBlockId'] = newId;
          jsonChanged = true;
        }
      }

      // Catalog leaf values contain collection root block IDs
      if (treeKind === TreeKind.CATALOG) {
        const values = node['values'] as Array<{ t?: string; value?: unknown }>;
        if (Array.isArray(values)) {
          for (let i = 0; i < values.length; i++) {
            const val = values[i];
            if (val && typeof val === 'object' && val.t === 'number' && typeof val.value === 'number') {
              const newId = relocated(val.value);
              if (newId !== val.value) {
                values[i] = { t: 'number', value: newId };
                jsonChanged = true;
              }
            }
          }
        }
      } else {
        const values = node['values'] as Array<{ t?: string; value?: unknown }>;
        if (Array.isArray(values)) {
          for (let i = 0; i < values.length; i++) {
            const val = values[i];
            if (val && typeof val === 'object' && val.t === 'number' && typeof val.value === 'number') {
              const newId = relocated(val.value);
              if (newId !== val.value) {
                values[i] = { t: 'number', value: newId };
                jsonChanged = true;
              }
            }
          }
        }
      }
    }

    // Check if any block in chain was relocated
    const chainMoved = chain.some((id) => relocationMap.has(id));

    if (!jsonChanged && !chainMoved) continue;

    if (jsonChanged) {
      // Re-serialize JSON and write all blocks to (potentially new) positions.
      // Re-apply FBC1 payload encoding so compressed nodes remain compressed —
      // writing raw JSON would exceed the original chain length for large nodes.
      const newData = Buffer.from(JSON.stringify(node), 'utf-8');
      const newEncoded = fbf.encodePayload(newData);
      const lengthPrefix = Buffer.alloc(LENGTH_PREFIX_SIZE);
      lengthPrefix.writeBigUInt64LE(BigInt(newEncoded.length), 0);
      const newFull = Buffer.concat([lengthPrefix, newEncoded]);

      for (let i = 0; i < chain.length; i++) {
        const newBlockId = relocated(chain[i]);
        const nextNewBlockId = i + 1 < chain.length ? relocated(chain[i + 1]) : NO_BLOCK;

        const out = Buffer.alloc(blockSize, 0);
        out.writeUInt32LE(nextNewBlockId >>> 0, 0);
        const start = i * payloadSize;
        const end = Math.min(start + payloadSize, newFull.length);
        if (start < newFull.length) {
          newFull.copy(out, NEXT_POINTER_SIZE, start, end);
        }
        await fbf.stageRawBlock(newBlockId, out);
      }
    } else {
      // JSON unchanged, only chain positions moved — copy raw blocks with updated nextPtr
      for (let i = 0; i < chain.length; i++) {
        const newBlockId = relocated(chain[i]);
        const nextNewBlockId = i + 1 < chain.length ? relocated(chain[i + 1]) : NO_BLOCK;

        const block = Buffer.from(rawBlocks[i]);
        block.writeUInt32LE(nextNewBlockId >>> 0, 0);
        await fbf.stageRawBlock(newBlockId, block);
      }
    }
  }

  // Update block 0 (header)
  header.catalogRootBlockId = relocated(header.catalogRootBlockId);
  for (const collMeta of Object.values(header.collections)) {
    collMeta.rootBlockId = relocated(collMeta.rootBlockId);
    for (const [field, indexBlockId] of Object.entries(collMeta.indexes)) {
      collMeta.indexes[field] = relocated(indexBlockId);
    }
  }

  const headerJson = Buffer.from(JSON.stringify(header));
  const headerBlock = Buffer.alloc(blockSize, 0);
  headerBlock.writeUInt32LE(NO_BLOCK >>> 0, FREE_LIST_HEAD_OFFSET); // no free blocks remain
  headerBlock.writeUInt32LE(headerJson.length >>> 0, HEADER_LENGTH_OFFSET);
  headerJson.copy(headerBlock, HEADER_CLIENT_AREA_OFFSET);
  await fbf.stageRawBlock(0, headerBlock);

  // Atomic commit — flushes all staged writes
  await fbf.commit();

  // ── Phase 4: Truncate ─────────────────────────────────────────────────

  const liveBlockCount = totalBlocks - blocksFree;
  const newFileSize = liveBlockCount * blockSize;
  await file.truncate(newFileSize);

  return {
    success: true,
    blocksTotal: totalBlocks,
    blocksFree,
    blocksRelocated: relocationMap.size,
    sizeBefore,
    sizeAfter: newFileSize,
  };
}
