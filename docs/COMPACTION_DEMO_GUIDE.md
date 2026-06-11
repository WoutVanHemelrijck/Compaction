# Showcasing the Compaction Module

A presentation script for demoing `shrinkDatabase()` — the in-place space
reclamation half of the compaction module — plus the storage principles behind it.

## What the demo runs on

A single in-process `SimpleDBMS` in **single-file mode**: documents (as blobs)
and all B+ tree indexes live in **one `FreeBlockFile`** — fixed 4 KB blocks.
That one file is exactly what `shrinkDatabase()` compacts, so everything you
delete and reclaim is visible in one block map. No Raft, no cluster — nothing
that isn't the compaction module and the storage it operates on.

```bash
npm run demo      # builds, starts the server, serves the UI
# open http://localhost:4000/
```

Backend-only version (prints the block map at each step in the terminal):

```bash
node scripts/showcase.mjs
```

---

## The 60-second mental model (say this first)

- The database is **one file of fixed 4 KB blocks**. Block 0 is the header.
- Everything else is a **blob**: a document, or a B+ tree node (the catalog,
  the primary `id` index, and one secondary index per field). A blob can chain
  across several blocks via a 4-byte "next" pointer.
- **Deleting** frees a blob's blocks. Two things can happen to a freed block:
  - it goes on the **free list** (a linked list of holes, reused on next insert), or
  - it becomes an **orphan** — dropped by the B+ tree without being re-linked.
- Over time the file is full of holes and orphans — **fragmentation**. The live
  data would fit in a fraction of the file, but the file never shrank.
- `shrinkDatabase()` fixes this **in place, with zero extra disk space**.

---

## The demo arc (5 acts)

### Act 1 — Empty file: what's always there
Fresh start. The block map shows **3 blocks**: `[0 Header] [1 Catalog] [2 Primary index]`.
- *"Block 0 holds the free-list head pointer and the roots of every B+ tree.
  Even an empty database has a catalog and a primary-key index."*
- Click block 0 → show the header decodes to the catalog root + collection roots.

### Act 2 — Insert a few: structure forms
Insert 6 (set **Copies = 6**).
- New **orange Document blocks** appear, and **secondary indexes** show up
  (one per field — name, dept, level).
- Click a **Primary index** block → it lists `docId → block id` (the key points
  at the document's blob). Click a **Document** block → the actual JSON you stored.
- *Principle:* an index stores **keys + pointers**; the document body is a
  separate blob. The index is how you find the blob.

### Act 3 — Fill it up: B+ trees split, fanout
Insert lots (set **Copies = 60**, optionally **Pad size = 1 KB**).
- The file jumps to ~80 blocks: ~60 document blobs + several index blocks.
- *Principle (fanout):* the index grew far slower than the document count — a
  leaf packs ~10–20 keys before it **splits** into two blocks. That's why B+
  trees stay shallow. Padding shows the other axis: bigger documents = more
  blocks, because the body is stored in the file too.

### Act 4 — Delete most: fragmentation
Set **Delete first = 48**, click it.
- The grid fills with **gray dashed Free holes** (freed document/index blocks
  on the free list) and **red dashed Orphans** (blocks the tree abandoned).
- The **Reclaimable / fragmentation** meter jumps to ~70%.
- *Principle:* the file is the same size, but most of it is wasted. Point out the
  **free-list chain** panel (the holes are literally a linked list) and that the
  orphans are *not* on it — *"only a full tree-walk finds those, which is exactly
  what shrink does."*

### Act 5 — Run `shrinkDatabase()`: the payoff
Click **Run shrinkDatabase()**. The log reports something like:
> relocated 17 live blocks, reclaimed 56 blocks, file 324 KB → 94 KB (71% smaller)

- The map collapses to a small, dense, hole-free file; fragmentation → 0%.
- Every surviving document is still readable (the demo verifies this).
- *Walk the 4 phases* (this is the heart of your module):
  1. **Build the block map** — walk the free list and every B+ tree to label
     each block live / free / orphan.
  2. **Build the relocation table** — pair the highest live blocks with the
     lowest free slots.
  3. **Relocate** — copy those live blocks down into the holes and **rewrite
     every pointer to them** (child pointers, sibling links, and the index
     entries that point at moved document blobs), staged and committed atomically.
  4. **Truncate** — drop the now-empty tail of the file.

---

## Principles worth name-dropping

- **Block / slotted storage:** fixed-size blocks + a free list is how real
  engines (SQLite pages, Postgres heap) manage space; reuse beats re-allocating.
- **Fragmentation is intrinsic:** any system with deletes leaves holes. The
  interesting question is how you reclaim them.
- **Two reclamation strategies (and the trade-off):**
  - `shrinkDatabase()` — in-place relocate + truncate. **Zero extra disk**, but
    must rewrite pointers and run while writes are quiesced.
  - `compactDatabase()` — stream everything into a fresh file and swap.
    Simpler/robust, but needs **2× disk** temporarily (like SQLite `VACUUM`).
- **Orphans vs. free list:** a subtle correctness point — shrink can't trust the
  free list alone; it re-derives liveness by walking the trees, so it also
  reclaims blocks that leaked out of the free list.
- **Atomicity:** relocations are staged and committed via the WAL, so a crash
  mid-shrink can't corrupt the file.

## If asked "why not just always compact?"
Disk. `shrinkDatabase` runs when you *don't* have a spare copy's worth of free
space — e.g. the disk is already 70% full of a fragmented file. That's the whole
reason the in-place algorithm exists, and it's the harder, more interesting one
to have written.

## Reproducible numbers (verified)
Insert 60 (≈300 B each) → ~79 blocks → delete 48 → ~72% reclaimable →
`shrinkDatabase()` → 23 blocks, **~71% smaller**, **12/12 documents intact**.
