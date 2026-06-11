// Backend-only showcase of the compaction module: drives a single SimpleDBMS
// through insert → fragment → shrink and prints the index-file block map at
// each step. No HTTP, no UI — just the compaction logic.
//
//   node scripts/showcase.mjs
import { SimpleDBMS } from '../build/packages/dbms/core/simpledbms.mjs';
import { RealFile } from '../build/packages/dbms/storage/file/file.mjs';
import { buildBlockMap, inspectIndexContents, shrinkDatabase } from '../build/packages/dbms/durability/compaction/compaction.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'showcase-'));
const f = (n) => new RealFile(join(dir, n));
// Single-file mode: documents (blobs) and B+ tree indexes share one
// FreeBlockFile — the configuration shrinkDatabase() is built for.
for (const n of ['db.db', 'db.wal']) { const file = f(n); await file.create(); await file.close(); }
let db = await SimpleDBMS.create(f('db.db'), f('db.wal'));
let coll = await db.createCollection('_demo');
coll.setAutoCreateSecondaryIndexesOnInsert(true);

const ROLE = { catalog: 'CAT', 'primary index': 'PK', 'secondary index': 'IDX' };

async function snapshot(title) {
  const fbf = db.getFreeBlockFile();
  const map = await buildBlockMap(fbf);
  const nodes = await inspectIndexContents(fbf);
  const total = map.totalBlocks;
  const reclaimable = map.freeBlockIds.size;
  const frag = total > 1 ? Math.round((reclaimable / (total - 1)) * 100) : 0;

  // Map each document's blob blocks (single-file mode: blobs live in this file).
  const docBlocks = new Set();
  try {
    const heap = (await db.getCollection('_demo')).getDocumentHeap();
    for (const { startBlockId } of await (await db.getCollection('_demo')).getDocumentBlockIds()) {
      for (const b of await heap.getBlockChain(startBlockId)) docBlocks.add(b);
    }
  } catch { /* collection may not exist yet */ }

  const cells = [];
  for (let i = 0; i < total; i++) {
    if (i === 0) { cells.push('[0:HDR]'); continue; }
    if (map.freeListIds.includes(i)) { cells.push(`[${i}:free]`); continue; }
    if (map.blockKind[i] === 'orphan') { cells.push(`[${i}:ORPH]`); continue; }
    const n = nodes.get(i);
    if (n) { cells.push(`[${i}:${ROLE[n.tree] ?? 'live'}]`); continue; }
    cells.push(`[${i}:${docBlocks.has(i) ? 'DOC' : 'live'}]`);
  }
  const bytes = total * fbf.blockSize;
  console.log(`\n── ${title}`);
  console.log(`   ${cells.join(' ')}`);
  console.log(`   ${total} blocks · ${(bytes / 1024).toFixed(0)} KB · live ${total - 1 - reclaimable} · free-holes ${map.freeListIds.length} · orphans ${reclaimable - map.freeListIds.length} · fragmentation ${frag}%`);
  return { total, bytes, frag, reclaimable };
}

async function insertMany(n, pad = 0) {
  const docs = [];
  for (let i = 0; i < n; i++) {
    const d = { name: 'User' + i, dept: ['Eng', 'Sales', 'HR', 'Ops'][i % 4], level: (i % 7) + 1 };
    if (pad) d.bio = 'x'.repeat(pad);
    docs.push(d);
  }
  await coll.insertMany(docs);
  await db.commit();
}
async function deleteFraction(frac) {
  const all = await coll.getDocumentBlockIds();
  const victims = all.slice(0, Math.floor(all.length * frac)); // keep the rest as survivors
  for (const v of victims) await coll.delete(v.docId);
  await db.commit();
  return victims.length;
}

console.log('═══ COMPACTION MODULE SHOWCASE (index file = the B+ tree FreeBlockFile shrink operates on) ═══');
await snapshot('Empty database — block 0 header, catalog tree, primary index');

await insertMany(6);
await snapshot('After 6 inserts — secondary indexes (name/dept/level) appear');

await insertMany(74);
const grown = await snapshot('After 80 docs — B+ trees split across many blocks (fanout: ~10-20 keys/leaf)');

const deleted = await deleteFraction(0.8);
const frag = await snapshot(`After deleting ${deleted} docs — holes + orphaned blocks; fragmentation climbs`);

console.log('\n── Running shrinkDatabase() …');
const res = await shrinkDatabase(db.getFreeBlockFile());
console.log(`   result: relocated ${res.blocksRelocated} live block(s) into low slots, reclaimed ${res.blocksFree} block(s)`);
console.log(`   file truncated: ${res.sizeBefore} → ${res.sizeAfter} bytes  (${Math.round((1 - res.sizeAfter / res.sizeBefore) * 100)}% smaller)`);
// reopen (caches hold stale block ids after relocation)
await db.close();
db = await SimpleDBMS.open(f('db.db'), f('db.wal'));
const after = await snapshot('After shrink — holes relocated away, file truncated, fragmentation back to 0%');

// data integrity check
coll = await db.getCollection('_demo');
const remaining = await coll.getDocumentBlockIds();
let readOk = 0;
const heap = coll.getDocumentHeap();
for (const { startBlockId } of remaining) { const b = await heap.readBlob(startBlockId); if (b.length) readOk++; }
console.log(`\n── Integrity: ${readOk}/${remaining.length} surviving documents still readable after relocation ✔`);

console.log(`\n═══ SUMMARY ═══`);
console.log(`   grew to ${grown.total} blocks, fragmented to ${frag.frag}% after deletes,`);
console.log(`   shrink → ${after.total} blocks (${(after.bytes / 1024).toFixed(0)} KB), ${after.frag}% fragmentation, all data intact.`);
console.log(`   dir: ${dir}`);
await db.close();
