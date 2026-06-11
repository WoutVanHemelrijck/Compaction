// Standalone compaction demo server.
//
// Deliberately minimal: a single in-process SimpleDBMS instance plus the
// compaction module. No Raft, no proxy, no cluster, no FSM — none of that is
// needed to demonstrate how the index file fragments and how shrinkDatabase()
// reclaims the space. Every request runs against one database, serialized by a
// small mutex, so the demo is deterministic and robust.

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { SimpleDBMS, type Document } from '../../packages/dbms/core/simpledbms.mjs';
import { RealFile } from '../../packages/dbms/storage/file/file.mjs';
import {
  buildBlockMap,
  inspectIndexContents,
  shrinkDatabase,
} from '../../packages/dbms/durability/compaction/compaction.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env['PORT']) || 4000;
const COLLECTION = '_demo';

// Fresh data directory every run, so the demo always starts empty.
const dataDir = path.join(__dirname, '.compaction-demo-data');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

// Single-file mode: documents (as blobs) AND the B+ tree indexes live in ONE
// FreeBlockFile. This is the configuration shrinkDatabase() is designed and
// tested for — it relocates document blobs and tree nodes correctly, so data
// survives compaction intact. It also makes the demo richer: documents show up
// as real blocks, so inserting/deleting and padding documents all visibly grow
// and fragment the very file shrink reclaims.
const paths = {
  db: path.join(dataDir, 'database.db'),
  wal: path.join(dataDir, 'database.wal'),
};

async function openDb(create: boolean): Promise<SimpleDBMS> {
  if (create) {
    // create() opens with 'w+', which truncates — only do this for a fresh DB.
    for (const p of [paths.db, paths.wal]) {
      const f = new RealFile(p);
      await f.create();
      await f.close();
    }
    return SimpleDBMS.create(new RealFile(paths.db), new RealFile(paths.wal));
  }
  // Reopen the existing files in place (no truncation).
  return SimpleDBMS.open(new RealFile(paths.db), new RealFile(paths.wal));
}

let db = await openDb(true);
await db.createCollection(COLLECTION);

// ── Serialize every DB operation ──────────────────────────────────────────
// Node is single-threaded, but handlers await, so two requests can interleave.
// Chaining them through one promise guarantees inspect never reads mid-write
// and shrink never overlaps an insert/delete — the entire class of races that
// made the Raft version fragile simply cannot occur here.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const result = opChain.then(fn, fn);
  opChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function getCollection() {
  const names = await db.getCollectionNames();
  const coll = names.includes(COLLECTION) ? await db.getCollection(COLLECTION) : await db.createCollection(COLLECTION);
  coll.setAutoCreateSecondaryIndexesOnInsert(true);
  return coll;
}

// ── Inspection: classify + decode every block of the index FreeBlockFile ────
async function inspect() {
  const fbf = db.getFreeBlockFile();
  const map = await buildBlockMap(fbf);
  const nodeContents = await inspectIndexContents(fbf);

  const blockSize = fbf.blockSize;
  const totalBlocks = map.totalBlocks;
  const KEY_LIMIT = 64;

  type BlockContent = Record<string, unknown>;
  const content = new Map<number, BlockContent>();

  const freeListHead = await fbf.debug_getFreeListHead();
  content.set(0, {
    role: 'header',
    description: 'Stores the free-list head pointer and the database header (B+ tree roots).',
    freeListHead,
    header: map.header,
  });

  for (const [startId, node] of nodeContents) {
    const decoded: BlockContent = {
      role: 'btree-node',
      tree: node.tree,
      field: node.field,
      nodeType: node.nodeType,
      keyCount: node.keys.length,
      keys: node.keys.slice(0, KEY_LIMIT),
      chain: node.chain,
    };
    if (node.nodeType === 'leaf') {
      decoded['values'] = (node.values ?? []).slice(0, KEY_LIMIT);
      decoded['nextLeafBlockId'] = node.nextLeafBlockId;
      decoded['prevLeafBlockId'] = node.prevLeafBlockId;
    } else if (node.nodeType === 'internal') {
      decoded['childBlockIds'] = node.childBlockIds ?? [];
    }
    if (node.keys.length > KEY_LIMIT) decoded['keysTruncated'] = true;
    content.set(startId, decoded);
    for (let i = 1; i < node.chain.length; i++) {
      content.set(node.chain[i], {
        role: 'continuation',
        description: `Continuation of the B+ tree node blob starting at block ${startId}.`,
        blobStart: startId,
        chain: node.chain,
      });
    }
  }

  for (const id of map.freeListIds) {
    const raw = await fbf.readRawBlock(id);
    content.set(id, {
      role: 'free',
      description: 'A hole on the free list, reused on the next allocation.',
      nextFreePointer: raw.readUInt32LE(0),
    });
  }
  for (let id = 1; id < totalBlocks; id++) {
    if (map.blockKind[id] === 'orphan') {
      content.set(id, {
        role: 'orphan',
        description: 'Abandoned by the B+ tree without being re-linked into the free list; only shrink reclaims it.',
      });
    }
  }

  // Document blobs live in the SAME file (single-file mode). Map each blob
  // block to its document so the grid can colour them and the panel can show
  // the stored JSON.
  const documents: Array<{ docId: string; sizeBytes: number; data: Record<string, unknown> | null }> = [];
  const docBlock = new Map<number, { docId: string; data: Record<string, unknown> | null; chain: number[] }>();
  let docPayloadBytes = 0;
  const coll = await getCollection();
  const heap = coll.getDocumentHeap();
  for (const { docId, startBlockId } of await coll.getDocumentBlockIds()) {
    let data: Record<string, unknown> | null = null;
    let sizeBytes = 0;
    let chain: number[] = [];
    try {
      chain = await heap.getBlockChain(startBlockId);
      const buf = await heap.readBlob(startBlockId);
      sizeBytes = buf.length;
      docPayloadBytes += sizeBytes;
      if (buf.length > 0) data = JSON.parse(buf.toString()) as Record<string, unknown>;
    } catch {
      /* skip unreadable blob */
    }
    documents.push({ docId, sizeBytes, data });
    for (const b of chain) docBlock.set(b, { docId, data, chain });
  }

  // Document-blob block contents (start block carries the doc; rest continue it).
  for (const [blockId, info] of docBlock) {
    if (blockId === info.chain[0]) {
      content.set(blockId, {
        role: 'document',
        docId: info.docId,
        data: info.data,
        chain: info.chain,
        description: 'A document stored as a blob. shrink relocates the whole chain and rewrites the index pointer to it.',
      });
    } else {
      content.set(blockId, {
        role: 'continuation',
        description: `Continuation of the document blob starting at block ${info.chain[0]}.`,
        blobStart: info.chain[0],
        chain: info.chain,
      });
    }
  }

  // Colour each block by its true role.
  const treeToKind: Record<string, string> = {
    catalog: 'catalog',
    'primary index': 'collection',
    'secondary index': 'index',
  };
  const nodeKind = new Map<number, string>();
  for (const node of nodeContents.values()) {
    const kind = treeToKind[node.tree] ?? 'live';
    for (const blockId of node.chain) nodeKind.set(blockId, kind);
  }
  const blocks = Array.from({ length: totalBlocks }, (_, id) => {
    const mapKind = map.blockKind[id] ?? 'free';
    let kind: string;
    if (id === 0) kind = 'header';
    else if (mapKind === 'free') kind = 'free';
    else if (mapKind === 'orphan') kind = 'orphan';
    else if (nodeKind.has(id)) kind = nodeKind.get(id)!;
    else if (docBlock.has(id)) kind = 'document';
    else kind = 'live';
    let c = content.get(id) ?? null;
    if (!c && kind !== 'free' && kind !== 'orphan') {
      c = { role: 'live', description: 'Live block that shrink preserves (may be relocated to a lower slot).' };
    }
    return { id, kind, content: c };
  });

  const freeListCount = map.freeListIds.length;
  const orphanCount = blocks.filter((b) => b.kind === 'orphan').length;
  const reclaimableCount = map.freeBlockIds.size;
  const liveCount = totalBlocks - 1 - reclaimableCount;
  const usableBlocks = totalBlocks - 1;
  const fragmentationPct = usableBlocks > 0 ? Math.round((reclaimableCount / usableBlocks) * 100) : 0;

  return {
    ok: true,
    collectionName: COLLECTION,
    totalBlocks,
    blockSize,
    fileSizeBytes: totalBlocks * blockSize,
    freeListIds: map.freeListIds,
    freeListCount,
    orphanCount,
    reclaimableCount,
    liveCount,
    fragmentationPct,
    blocks,
    documents,
    docStore: { docCount: documents.length, payloadBytes: docPayloadBytes },
  };
}

// ── HTTP ────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '64mb' }));

// __dirname is build/apps/api-server at runtime; the HTML lives in source.
const htmlPath = path.resolve(__dirname, '../../../apps/frontend/public/compaction-demo.html');
app.get(['/', '/compaction-demo.html'], (_req, res) => res.sendFile(htmlPath));

app.get('/db/demo/index-inspect/:collection', async (_req, res) => {
  try {
    res.json(await serialize(inspect));
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

app.post('/db/:collection', async (req, res) => {
  try {
    const doc = req.body as Omit<Document, 'id'>;
    await serialize(async () => {
      const coll = await getCollection();
      await coll.insert(doc);
      await db.commit();
    });
    res.status(201).json({ success: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post('/db/:collection/insertMany', async (req, res) => {
  try {
    const documents = (req.body as { documents?: unknown }).documents;
    if (!Array.isArray(documents) || documents.length === 0) {
      res.status(400).json({ error: 'documents array is required' });
      return;
    }
    await serialize(async () => {
      const coll = await getCollection();
      await coll.insertMany(documents as Array<Omit<Document, 'id'>>);
      await db.commit();
    });
    res.json({ success: true, inserted: documents.length });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.delete('/db/:collection/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await serialize(async () => {
      const coll = await getCollection();
      await coll.delete(id);
      await db.commit();
    });
    res.json({ message: `Deleted ${id}` });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post('/db/demo/deleteMany/:collection', async (req, res) => {
  try {
    const ids = (req.body as { ids?: unknown }).ids;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
      res.status(400).json({ ok: false, error: 'ids must be an array of strings' });
      return;
    }
    await serialize(async () => {
      const coll = await getCollection();
      for (const id of ids as string[]) await coll.delete(id);
      await db.commit();
    });
    res.json({ ok: true, deleted: ids.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

app.post('/db/demo/shrink', async (_req, res) => {
  try {
    const result = await serialize(async () => {
      const r = await shrinkDatabase(db.getFreeBlockFile());
      // In-memory caches hold stale block ids after relocation: reopen the DB.
      await db.close();
      db = await openDb(false);
      return r;
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: (e as Error).message });
  }
});

app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║   SimpleDBMS — Compaction Demo                 ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log(`  Open  http://localhost:${PORT}/`);
  console.log('  (single in-process database — no cluster, no Raft)');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
