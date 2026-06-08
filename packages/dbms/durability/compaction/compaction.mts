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
 * manual `/db/shrink` endpoint relies on this), or by holding an
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

  // Compression service for decoding node payloads (algorithm read from envelope header)
  const nodeCompressionService = new CompressionService();

  // Track which blocks are free vs live
  const blockStatus = new Array<'FREE' | 'LIVE' | undefined>(totalBlocks);
  const freeBlockIds = new Set<number>();
  const blobInfos: BlobInfo[] = [];

  // 1a: Walk the free list
  let freeHead = await fbf.debug_getFreeListHead();
  while (freeHead !== NO_BLOCK && freeHead < totalBlocks) {
    freeBlockIds.add(freeHead);
    blockStatus[freeHead] = 'FREE';
    const block = await fbf.readRawBlock(freeHead);
    freeHead = block.readUInt32LE(0);
  }

  // 1b: Parse header JSON from block 0
  const headerBuf = await fbf.readHeader();
  if (headerBuf.length === 0) {
    return {
      success: true,
      blocksTotal: totalBlocks,
      blocksFree: freeBlockIds.size,
      blocksRelocated: 0,
      sizeBefore,
      sizeAfter: sizeBefore,
    };
  }

  // Decompress header if it was compressed by SimpleDBMS
  let headerJsonBuf = headerBuf;
  const headerCompressed = deserializeCompressionEnvelope(headerBuf, HEADER_COMPRESSED_PAYLOAD_MAGIC);
  if (headerCompressed !== null) {
    const headerCompressionService = new CompressionService();
    headerJsonBuf = headerCompressionService.decompress(headerCompressed);
  }

  const header = JSON.parse(headerJsonBuf.toString()) as {
    catalogRootBlockId: number;
    collections: {
      [name: string]: {
        rootBlockId: number;
        indexes: { [field: string]: number };
      };
    };
  };

  // Helper: follow a blob's block chain via nextPtr
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
    for (const blockId of chain) {
      blockStatus[blockId] = 'LIVE';
    }
    blobInfos.push({ startBlockId, chain, kind: 'document', treeKind: TreeKind.COLLECTION });
  }

  // Helper: read blob payload from a chain (strips length prefix)
  function readBlobDataFromParts(parts: Buffer[]): Buffer {
    const full = Buffer.concat(parts);
    if (full.length < LENGTH_PREFIX_SIZE) return Buffer.alloc(0);
    const len = Number(full.readBigUInt64LE(0));
    return Buffer.from(full.slice(LENGTH_PREFIX_SIZE, LENGTH_PREFIX_SIZE + len));
  }

  // 1c: Recursively walk all B+ trees
  async function walkTree(rootBlockId: number, treeKind: TreeKind): Promise<void> {
    if (rootBlockId === NO_BLOCK || rootBlockId >= totalBlocks) return;
    if (blockStatus[rootBlockId] === 'LIVE') return; // already visited

    const chain = await readBlobChain(rootBlockId);
    for (const blockId of chain) {
      blockStatus[blockId] = 'LIVE';
    }
    blobInfos.push({ startBlockId: rootBlockId, chain, kind: 'node', treeKind });

    // Read and parse the node JSON
    const parts: Buffer[] = [];
    for (const blockId of chain) {
      const block = await fbf.readRawBlock(blockId);
      parts.push(Buffer.from(block.slice(NEXT_POINTER_SIZE)));
    }
    const data = readBlobDataFromParts(parts);
    if (data.length === 0) return;

    // Decode FBC1 wrapper (applied by FreeBlockFile.encodePayload), then ZST1 wrapper (applied by FBNodeStorage)
    const decodedFBC1 = fbf.decodePayload(data);
    const nodeCompResult = deserializeCompressionEnvelope(decodedFBC1, NODE_STORAGE_COMPRESSED_PAYLOAD_MAGIC);
    const jsonBuf = nodeCompResult !== null ? nodeCompressionService.decompress(nodeCompResult) : decodedFBC1;

    const node = JSON.parse(jsonBuf.toString('utf-8')) as {
      type: string;
      childBlockIds?: number[];
      values?: Array<{ t?: string; value?: unknown }>;
      nextBlockId?: number;
      prevBlockId?: number;
    };

    if (node.type === 'internal' && Array.isArray(node.childBlockIds)) {
      for (const childId of node.childBlockIds) {
        if (typeof childId === 'number' && childId !== NO_BLOCK) {
          await walkTree(childId, treeKind);
        }
      }
    } else if (node.type === 'leaf') {
      if (treeKind === TreeKind.CATALOG) {
        // Catalog leaf values are collection root block IDs
        if (Array.isArray(node.values)) {
          for (const val of node.values) {
            const blockId =
              val && typeof val === 'object' && val.t === 'number' && typeof val.value === 'number'
                ? val.value
                : undefined;
            if (typeof blockId === 'number' && blockId !== NO_BLOCK) {
              await walkTree(blockId, TreeKind.COLLECTION);
            }
          }
        }
      } else if (Array.isArray(node.values)) {
        // Collection and secondary-index leaf values are document blob start IDs.
        for (const val of node.values) {
          const blockId =
            val && typeof val === 'object' && val.t === 'number' && typeof val.value === 'number'
              ? val.value
              : undefined;
          if (typeof blockId === 'number' && blockId !== NO_BLOCK) {
            await markDocumentBlob(blockId);
          }
        }
      }
    }
  }

  // Walk catalog tree
  await walkTree(header.catalogRootBlockId, TreeKind.CATALOG);

  // Walk index trees (referenced from header, not from catalog tree)
  for (const collMeta of Object.values(header.collections)) {
    for (const indexRootBlockId of Object.values(collMeta.indexes)) {
      if (typeof indexRootBlockId === 'number' && indexRootBlockId !== NO_BLOCK) {
        await walkTree(indexRootBlockId, TreeKind.INDEX);
      }
    }
  }

  // Any unvisited block is an orphan → treat as free
  for (let i = 1; i < totalBlocks; i++) {
    if (blockStatus[i] === undefined) {
      freeBlockIds.add(i);
      blockStatus[i] = 'FREE';
    }
  }

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
