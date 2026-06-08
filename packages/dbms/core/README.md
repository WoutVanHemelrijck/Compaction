# Core Module (`src/core/`)

The heart of SimpleDBMS. Assembles all subsystems and provides the main API for database operations.

## Contents

- **`simpledbms.mts`** - Main `SimpleDBMS` class
- **`simpledbms.spec.mts`** - Comprehensive unit tests
- **`trivialdbms.mts`** - Simplified prototype (reference implementation)
- **`trivialdbms.test.mts`** - Tests for prototype
- **`invariants.mts`** - Consistency checks and debug assertions
- **`debug-global-constants.mts`** - Debug logging utilities

## Architecture

```
SimpleDBMS
├─ Collections (Map<name, Collection>)
│  └─ Collection
│     └─ Documents (indexed by BPlusTree)
├─ Primary Index (BPlusTree<docId, blockId>)
├─ Secondary Indexes (Map<field, BPlusTree>)
├─ Storage Manager
│  ├─ FreeBlockFile (page allocator)
│  ├─ NodeStorage (B+ tree node cache)
│  └─ File (disk I/O)
├─ WAL Manager (write-ahead log)
├─ Compression Service
└─ HNSW Vector Index (semantic search)
```

## Key Methods

| Method                                         | Purpose                | Notes               |
| ---------------------------------------------- | ---------------------- | ------------------- |
| `create(file, walFile)`                        | Initialize database    | Static factory      |
| `open(file, walFile)`                          | Load existing database | Recovers from crash |
| `createCollection(name)`                       | Add table              | Persistent          |
| `dropCollection(name)`                         | Delete table           | Cascades to indexes |
| `collection.executeSqlQuery(sql)`              | Execute SQL query      | Parses & optimizes  |
| `collection.executeNaturalLanguageQuery(text)` | Execute NL query       | Uses RAG agent      |
| `compactDatabase()`                            | Reclaim disk space     | ~O(N) time          |
| `close()`                                      | Shutdown cleanly       | Flushes all changes |

## Important Details

### Transaction Semantics

- **ACID** - Atomicity, Consistency, Isolation, Durability
- **Isolation Level**: Serializable (single-threaded execution)
- **Consistency**: Invariants checked on close via `invariants.mts`

### Memory Usage

- **LRU Node Cache**: Configurable size (default: ~100MB)
- **Document Buffer**: Compressed on disk, decompressed on read
- **Index Cache**: Hot index nodes in memory

### Crash Recovery

1. Open database file
2. Scan WAL log for uncommitted transactions
3. Discard uncommitted ops
4. Rebuild indexes from primary data

**Result**: Zero data loss; consistent state guaranteed.

### Performance Tuning

Environment variables:

- `AUTO_COMPACTION_THRESHOLD` (default: 50) - Trigger compaction at X% fragmentation
- `COMPRESSION_ALGORITHM` (default: zstd) - Algorithm for payload compression
- `NODE_CACHE_SIZE` (default: 100000000) - Max bytes for LRU cache

## Testing

```bash
# Run all core tests
npm test -- src/core/simpledbms.spec.mts

# Run with coverage
npm run coverage

# Debug specific test
npm test -- src/core/simpledbms.spec.mts -t "insertOne"
```

## Design Decisions

### Why Layered Assembly?

The `SimpleDBMS` class doesn't implement indexing or storage itself; it **composes** subsystems:

- **Testability**: Mock storage layer, test engine logic in isolation
- **Flexibility**: Swap implementations without changing engine
- **Clarity**: Each subsystem has single responsibility

### Why Synchronous API?

Most methods are async (`insertOne`, `find`, etc.) because:

- Disk I/O is inherently async
- Follows Node.js conventions
- Allows batching writes internally

### Distributed Deployment with Raft

SimpleDBMS is a **single-node library**. For distributed, replicated setups:

- Wrap in REST API server (`src/server/simpledbmsd.mts`)
- Use Raft consensus replication (`raft-consensus-algorithm/`)

Each node in a Raft cluster runs its own SimpleDBMS instance. The Raft layer coordinates:

- **Leader Election**: One leader handles writes, followers are read-only
- **Log Replication**: Write operations replicated to all followers
- **Consensus**: Writes committed only after majority acknowledgment
- **Failover**: Automatic leader election on node failure

For cluster setup and examples, see [Full Architecture - Cluster & Replication](../../docs/ARCHITECTURE.md#cluster--replication-raft).

## Future Enhancements

1. **Concurrent transactions** - Currently single-threaded
2. **Query parallelization** - Execute scans in parallel
3. **Adaptive indexing** - Auto-choose best index types
4. **Incremental backups** - Backup only changed blocks
5. **Column-oriented storage** - For analytical workloads

## Debugging

Enable detailed logging with: `DEBUG=simpledbms:*`

## References

- [Full Architecture](../../docs/ARCHITECTURE.md)
- [Query Language](../query-language/README.md)
- [Storage Layer](../storage/README.md)
- [B+ Tree Indexing](../indexes/README.md)
