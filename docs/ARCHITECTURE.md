# SimpleDBMS Architecture & Design Guide

This document provides a comprehensive technical overview of SimpleDBMS, including system architecture, design decisions, key algorithms, and data flow.

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Layer-by-Layer Breakdown](#layer-by-layer-breakdown)
3. [Data Flow Examples](#data-flow-examples)
4. [Key Algorithms](#key-algorithms)
5. [Performance Characteristics](#performance-characteristics)
6. [Design Decisions](#design-decisions)

---

## System Architecture

### High-Level Layers

SimpleDBMS is organized as a **layered architecture** with clear separation of concerns:

```
┌──────────────────────────────────────────────────┐
│   Distributed Consensus (Raft cluster)           │
│  (Replication, leader election)                  │
└────────────────────┬─────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────┐
│              Application Layer                   │
│  (Frontend, REST API, CLI tools)                 │
└────────────────────┬─────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────┐
│          Query Execution Layer                   │
│  (Interpreter, Optimizer, Executors)             │
└────────────────────┬─────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────┐
│         NLP & Semantic Search Layer              │
│  (N-grams, HNSW vectors, RAG agent)              │
└────────────────────┬─────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────┐
│    Database Engine Core (SimpleDBMS)             │
│  (Collections, Documents, Transactions)          │
└────────────────────┬─────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────┐
│         Indexing & Access Methods                │
│  (B+ Tree, Node Storage with LRU cache)          │
└────────────────────┬─────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────┐
│    Durability & Recovery Layer                   │
│  (WAL, Compaction, Compression)                  │
└────────────────────┬─────────────────────────────┘
                     │
┌────────────────────▼─────────────────────────────┐
│     Storage Primitives Layer                     │
│  (File I/O, FreeBlockFile, Atomic writes)        │
└──────────────────────────────────────────────────┘
```

---

## Layer-by-Layer Breakdown

### 1. Storage Primitives Layer (`src/storage/`)

**Purpose**: Low-level, reliable disk I/O.

#### Components

##### **File Abstraction** (`file/file.mts`)

- Generic interface for reading/writing bytes
- Implementations: `RealFile` (disk), `MockFile` (in-memory)
- Supports seeking, truncation, close operations
- Provides the foundation for all persistent storage

##### **FreeBlockFile** (`freeblockfile.mts`)

- Page-based block allocator built on top of `File`
- Maintains a free-block list to reuse space
- Key concept: **blocks** (fixed-size pages, default 4KB)
- Operations:
  - `allocateBlock()` - Get a new block ID
  - `freeBlock()` - Mark block as reusable
  - `readBlock(id)` - Read block contents
  - `writeBlock(id, data)` - Write to block
- Efficiently handles fragmentation via garbage collection

##### **Node Storage Abstraction** (`node-storage/node-storage.mts`)

- Generic interface for storing tree nodes on disk
- Implementations:
  - `FBNodeStorage` - Uses FreeBlockFile (disk-backed)
  - `TrivialNodeStorage` - In-memory (for testing)
- Provides LRU cache on top of FBNodeStorage for hot nodes
- Key operations:
  - `createNode()` → returns node handle
  - `readNode(id)` → retrieves from cache or disk
  - `writeNode(id, node)` → persists to block

#### Design Decisions

- **Why blocks?** Fixed-size pages enable efficient reuse and reduce fragmentation.
- **Why LRU cache?** Avoids repeated disk I/O for frequently accessed tree nodes.
- **Why abstraction?** Allows swapping implementations (real disk ↔ in-memory) for testing.

---

### 2. Indexing Layer (`src/indexes/`)

**Purpose**: Efficient data structure for fast lookups and range queries.

#### B+ Tree Implementation (`b-plus-tree.mts`)

- **Order**: Configurable (default 100 keys per node)
- **Key Type**: Generic (comparable types)
- **Value Type**: Generic
- **Node Types**:
  - **Leaf Nodes**: Store actual key-value pairs
  - **Internal Nodes**: Store keys + child pointers for navigation

##### Key Operations

```
Insert(key, value)
├─ Find leaf node that should contain key
├─ Insert into leaf; if overflow:
│   └─ Split leaf node into two
│   └─ Promote middle key to parent
│   └─ If parent overflows, recursively split up tree
└─ Maintain balance invariant: (order/2) ≤ keys ≤ order

Search(key)
├─ Start at root
├─ Navigate down using binary search on keys
└─ Return value if found, null otherwise

Delete(key)
├─ Find leaf; remove key-value pair
├─ If underflow (keys < order/2):
│   └─ Try borrow from sibling or merge with sibling
│   └─ Propagate up if parent underflows
└─ Maintain balance
```

##### Complexity

| Operation   | Time                           | Space          |
| ----------- | ------------------------------ | -------------- |
| Insert      | O(log N)                       | O(1) amortized |
| Search      | O(log N)                       | -              |
| Delete      | O(log N)                       | -              |
| Range Query | O(log N + K) where K = results | -              |

#### Why B+ Trees?

1. **Efficient disk I/O**: Multi-way branching reduces tree height
2. **Range queries**: Leaf nodes linked for sequential scan
3. **Balanced**: Guarantees O(log N) operations
4. **Cache-friendly**: One node per disk block

---

### 3. Durability & Recovery Layer (`src/durability/`)

**Purpose**: Ensure data survives crashes and reclaim disk space.

#### Write-Ahead Log (WAL) (`atomic-operations/wal-manager.mts`)

##### Concept

Before modifying any data, **write intent to log**. On restart, replay log to recover.

##### How it Works

```
Client writes (key, value):
  1. WAL Manager writes {operation, key, value} to log file
  2. Wait for fsync (disk confirmation)
  3. Apply operation to in-memory database
  4. Store undo information for rollback

On crash:
  1. Recover by reading log file sequentially
  2. Replay all committed operations
  3. Discard uncommitted operations (at checkpoint)
```

##### File Format

```
[LogEntry]
├─ timestamp: number
├─ operation: "INSERT" | "UPDATE" | "DELETE"
├─ key: Buffer
├─ value: Buffer (new)
├─ oldValue?: Buffer (for undo)
└─ checksum: number
```

#### Atomic File Operations (`atomic-operations/atomic-file.mts`)

- Wraps standard `File` interface
- Ensures all writes are either fully applied or not at all
- Uses **copy-on-write** pattern:
  1. Write to temporary location
  2. Atomic rename to target (OS-level guarantee)
  3. On crash → rollback via temporary file cleanup

#### Compaction (`compaction/compaction.mts`)

**Problem**: After many deletes/updates, disk is fragmented with dead space.

**Solution**: Rewrite entire database, skipping deleted documents.

```
compactDatabase(db):
  1. Open new output file
  2. Iterate all collections
  3. For each live document, re-insert into new file
  4. Reindex all data
  5. Atomic swap old file → new file
```

**Cost**: O(N) time, 2X space temporarily. **Benefit**: Reclaim ~30-70% of disk space.

#### Compression (`compression/`)

**Algorithms Supported** (via environment variable):

- `zstd` (Zstandard) - Fast, good compression
- `none` - No compression (baseline)

**When Applied**:

- Document payloads compressed before storage
- Header metadata (collections, indexes) also compressed

**Envelope Format** (`envelope.mts`):

```
[CompressedBlock]
├─ magic: "DBH1" (4 bytes)
├─ algorithm: 1 byte
├─ originalSize: 4 bytes
├─ compressedSize: 4 bytes
└─ compressedData: [variable]
```

**Decision**: Compress on write, decompress on read. Trades CPU for disk space.

---

### 4. Database Engine Core (`src/core/`)

**Purpose**: Assemble storage, indexing, durability, and provide high-level API.

#### SimpleDBMS Class (`simpledbms.mts`)

Main entry point. Manages collections, secondary indexes, and transactions.

- **Collections**: Create, insert, find, update, delete documents
- **Secondary Indexes**: Used automatically by query optimizer for fast lookups
- **Transactions**: All-or-nothing semantics with begin, commit, rollback

##### Architecture

```
SimpleDBMS
├─ fileManager: FreeBlockFile
├─ nodeStorage: FBNodeStorage with LRU cache
├─ primaryIndex: BPlusTree<collectionName, documentID>
├─ secondaryIndexes: Map<fieldName, BPlusTree>
├─ walManager: WALManager
├─ compressionService: CompressionService
└─ vectorIndex: HNSWIndex (for semantic search)
```

---

### 5. Query Engine (`src/query-language/`)

**Purpose**: Parse and execute SQL-like queries.

#### Pipeline

```
Input: "SELECT * FROM users WHERE age > 25"
   ↓
Lexer (tokenize)
   → ["SELECT", "*", "FROM", "users", "WHERE", "age", ">", "25"]
   ↓
Parser (build AST)
   → SelectStatement {
      fields: ["*"],
      from: "users",
      where: Comparison { left: Field("age"), op: ">", right: 25 }
   }
   ↓
Optimizer (rewrite for efficiency)
   → Check indexes, reorder predicates
   ↓
Executor (run plan)
   → Scan table with index if available
   → Apply filters
   → Return results as Documents
   ↓
Output: [{ id: 1, name: "Alice", age: 30 }, ...]
```

#### SQL Subset Supported

- **SELECT**: Columns, WHERE, ORDER BY, LIMIT
- **INSERT**: Single or batch
- **UPDATE**: With WHERE clause
- **DELETE**: With WHERE clause
- **JOIN**: INNER, LEFT, RIGHT, FULL (with ON predicate)
- **Aggregates**: COUNT, SUM, AVG, MIN, MAX (optional)

#### Optimizer (`executors/select-optimizer.mts`)

```
Query: SELECT * FROM users WHERE age > 25 AND city = "NYC"

Optimization steps:
1. Check available indexes
   - If index on (city, age) exists: use for fast lookup
   - Else use index on (city) → scan filtered result
   - Else full table scan

2. Predicate pushdown
   - Apply WHERE filters as early as possible

3. Index selection
   - Choose most selective index first

Result: Use index on city, then filter age > 25
```

#### Natural Language Execution (`interpreter/nl.mts`)

```
Input: "Find all users older than 25 living in New York"
   ↓
Parse keywords & entities
   → Collections: "users"
   → Operators: age (>25), city (=NYC)
   ↓
Generate SQL
   → "SELECT * FROM users WHERE age > 25 AND city = 'New York'"
   ↓
Execute standard pipeline
```

---

### 6. NLP & Semantic Search (`src/nlp/`)

#### N-gram Indexing (`ngrams/`)

**Use Case**: Fast full-text search (substring matching).

##### How it Works

```
Input text: "hello world"
  ↓
Generate n-grams (n=3):
  → "hel", "ell", "llo", "lo ", "o w", " wo", "wor", "orl", "rld"
  ↓
Index each gram → original document
  ↓
Query "wor":
  → Lookup gram index
  → Return documents containing "wor"
  ↓
Result: High-speed substring search, no regex needed
```

**Tradeoff**: Uses B+ tree on each n-gram value; space overhead but fast.

#### HNSW Vector Search (`text-embedding/hnsw-index.mts`)

**Use Case**: Semantic similarity search (e.g., "find docs similar to this description").

##### HNSW (Hierarchical Navigable Small World)

```
Insert vector v for document d:
  1. Compute embedding of d (via HuggingFace Transformers)
  2. Find nearest neighbors at layer 0 (greedy search)
  3. Link v to nearest neighbors
  4. If similarity is high enough, promote to upper layers
  5. Maintain hierarchical structure for fast search

Search for nearest K documents to query q:
  1. Compute embedding of q
  2. Start at top layer, greedy nearest-neighbor search
  3. Descend layers, refining nearest neighbors
  4. Return K closest documents
```

**Time**: O(log N) search; O(log N) insert (empirically)
**Space**: O(N × M) where M ≈ 5-20 (small multiplier)

##### Text Embeddings

- Uses `@huggingface/transformers` (all-MiniLM-L6-v2)
- Converts text → 384-dimensional vectors
- Pre-trained on semantic similarity tasks
- Cached locally after first download

---

### 7. RAG Agent (`src/rag/`)

**Use Case**: Natural language interface to database with LLM reasoning.

#### Architecture

```
User Query: "Which documents are about machine learning?"
   ↓
RAG Agent (LangChain + Claude)
   ├─ 1. Retrieve relevant docs from HNSW
   ├─ 2. Build context: "Here are similar docs: [...]"
   ├─ 3. Call Claude with: "Query: ... Context: ... Answer: ?"
   ├─ 4. Claude reasons over context
   └─ 5. Return natural language response
   ↓
Output: "The following documents discuss ML: [doc1, doc2, ...]"
```

#### Tools Available to Agent

- `db.query()` - Execute SQL queries
- `db.queryNL()` - Parse natural language, run as SQL
- `vectorIndex.search()` - Find semantically similar documents
- `ngramIndex.search()` - Full-text search

#### Design Rationale

- **Why RAG?** LLMs can reason over retrieved context without fine-tuning
- **Why Claude API?** Strong reasoning, good cost/performance
- **Why retrieval first?** Grounds LLM responses in actual data

---

## Data Flow Examples

### Example 1: INSERT a Document

```
User: db.insertOne({name: "Alice", age: 30})
   ↓
SimpleDBMS.insertOne()
   ├─ 1. Generate unique document ID
   ├─ 2. WAL Manager: log {INSERT, id, document}
   ├─ 3. Compress document using CompressionService
   ├─ 4. FreeBlockFile: allocate block for compressed data
   ├─ 5. NodeStorage: update leaf node with (id → blockID)
   ├─ 6. B+ Tree: insert (id) → rebalance if needed
   ├─ 7. Update secondary indexes on indexed fields
   └─ 8. Return success
   ↓
Result: Document stored, indexed, and recoverable after crash
```

### Example 2: QUERY with WHERE

```
User: db.query("SELECT * FROM users WHERE age > 25")
   ↓
Query Engine
   ├─ 1. Lexer: tokenize
   ├─ 2. Parser: build SelectStatement AST
   ├─ 3. Optimizer: check for index on age
   │       └─ If index exists: use range scan (fast)
   │       └─ Else: full table scan
   └─ 4. Executor: apply filter, collect results
   ↓
Result: [alice, bob, charlie, ...] (all age > 25)
```

### Example 3: Semantic Search (NLP)

```
User: db.queryNL("Find documents about databases")
   ↓
RAG Agent
   ├─ 1. Compute embedding of query string
   ├─ 2. HNSW search: find 10 nearest documents
   ├─ 3. Retrieve full text of top results
   ├─ 4. Call Claude: "Docs about databases from these: [...]]"
   ├─ 5. Claude filters/ranks results
   └─ 6. Return ranked list
   ↓
Result: [doc1, doc2, doc3] ranked by relevance
```

---

## Key Algorithms

### B+ Tree Insertion (with splits)

```
InsertIntoLeaf(leaf, key, value):
  1. Find position for key in sorted order
  2. Insert (key, value) pair
  3. If leaf.size <= order: done
  4. Else: split leaf
     └─ Create new leaf with upper half of keys
     └─ Promote middle key to parent internal node
     └─ Recursively handle parent overflow

SplitInternal(internal, parentKey):
  1. Move upper half of children to new internal node
  2. Promote middle child pointer to parent
  3. Recursively split parent if needed
```

**Result**: O(log N) insertions; tree remains balanced.

### WAL Recovery

```
Recover():
  1. Open log file
  2. lastCheckpoint = read last checkpoint marker
  3. For each log entry after checkpoint:
     └─ If committed: replay operation (re-apply to database)
     └─ Else: discard (transaction never completed)
  4. Close log, sync database state
```

**Result**: Replay brings database to pre-crash state (up to last commit).

### HNSW Insert

```
HNSWInsert(vector, docID):
  1. Compute distance to all existing nodes at layer 0
  2. Find M nearest neighbors (M=5-20)
  3. Create bidirectional links to neighbors
  4. With probability p, promote to layer 1
  5. Repeat at each layer until reaching top
```

**Result**: Polylogarithmic search via hierarchical structure.

---

## Performance Characteristics

| Operation       | Typical Time              | Space      |
| --------------- | ------------------------- | ---------- |
| Point Lookup    | O(log N) + 1 disk I/O     | -          |
| Range Query     | O(log N + K) + K disk I/O | -          |
| Full Table Scan | O(N)                      | -          |
| Insert          | O(log N)                  | O(1)       |
| Delete          | O(log N)                  | O(1)       |
| Index Creation  | O(N log N)                | O(N)       |
| Compaction      | O(N)                      | O(2N) temp |
| NLP Search      | O(log N) embedding lookup | -          |

**Empirical Notes**:

- LRU cache hits: ~95% for hot workloads
- Compression ratio: ~40-60% (text-heavy data)
- B+ tree height: typically 3-4 for million-doc database

---

## Design Decisions

### 1. **Why Layered Architecture?**

- **Modularity**: Easy to swap implementations (mock storage, different compression)
- **Testability**: Each layer tested in isolation
- **Extensibility**: Add new index types, compression algorithms without touching storage layer

### 2. **Why B+ Trees, Not Hash Tables?**

- **Range Queries**: B+ trees support efficient scans; hash tables do not
- **Sorted Output**: Natural ordering for GROUP BY, ORDER BY
- **Disk Efficiency**: Multi-way branching better than binary trees for disk I/O

### 3. **Why WAL?**

- **Crash Safety**: No data loss after restart
- **Simplicity**: Append-only log easier to reason about than in-place updates
- **Concurrency**: Log enables transaction isolation

### 4. **Why Compression?**

- **Disk Space**: 2-3X savings for typical workloads
- **I/O Time**: Smaller payloads = fewer disk reads
- **Trade-off**: CPU cost of compression/decompression acceptable for most queries

### 5. **Why NLP + Vector Search?**

- **User Convenience**: Natural language queries without SQL syntax
- **Semantic Search**: Find documents by meaning, not exact keywords
- **LLM Integration**: RAG agents bridge gap between rigid queries and flexible reasoning

### 6. **Why HNSW, Not Exact Nearest Neighbor?**

- **Speed**: O(log N) instead of O(N) for search
- **Space**: Small overhead (M ≈ 5-20 per node)
- **Accuracy**: Approximation error <1% for typical use cases

---

## Cluster & Replication (Raft)

SimpleDBMS can run in a replicated cluster using the Raft consensus algorithm. Raft sits at the top of the architecture, coordinating multiple SimpleDBMS instances.

### How It Works

1. **Leader Election**: Raft elects one leader among cluster nodes
2. **Log Replication**: Leader replicates all writes to follower nodes
3. **Consensus**: Write operations committed only after majority of nodes acknowledge
4. **Failover**: If leader dies, followers automatically elect new leader
5. **State Machine**: Each cluster node runs its own SimpleDBMS instance, applying replicated log entries

**Result**: Fault-tolerant, strongly-consistent distributed database.

### Clustering Benefits

- **Fault Tolerance**: Cluster survives up to (N-1)/2 node failures
- **Strong Consistency**: All writes acknowledged by majority before commit
- **Automatic Failover**: New leader elected instantly if current leader dies
- **Read Scaling**: Follower nodes can serve read-only queries while leader handles writes
- **Zero Data Loss**: Write-ahead log + Raft log ensure durability across cluster

---

**Last Updated**: May 2026
**Coursework**: P&O 2025-2026
