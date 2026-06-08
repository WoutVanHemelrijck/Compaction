# Storage Layer (`src/storage/`)

Low-level reliable disk I/O and page-based memory management.

## Contents

- **`file/`** - File abstraction layer
  - `file.mts` - Generic interface
  - `file.spec.mts` - Tests
  - `mockfile.mts` - In-memory implementation for testing

- **`node-storage/`** - B+ tree node storage
  - `node-storage.mts` - Abstract interfaces
  - `fb-node-storage.mts` - Free-block-file-backed implementation
  - `trivial-node-storage.mts` - In-memory version
  - `LRU-cache.mts` - Hot-node caching layer
  - `*.spec.mts` - Tests

- **`freeblockfile.mts`** - Page-based block allocator
  - `freeblockfile.spec.mts` - Tests

## Architecture

```
Application Layer
        ↓
   FBNodeStorage (with LRU cache)
        ↓
    FreeBlockFile (page allocator)
        ↓
    File Interface
        ↓
    ╔═══════════════════════╗
    ║  Disk or Memory       ║
    ║  (RealFile/MockFile)  ║
    ╚═══════════════════════╝
```

## File Interface

Generic abstraction for reading/writing bytes with operations: `read()`, `write()`, `truncate()`, `flush()`, `close()`.

### Implementations

- **RealFile** - Disk I/O implementation
- **MockFile** - In-memory implementation (for testing)

## FreeBlockFile (Page Allocator)

Manages a database file as fixed-size **blocks** (pages).

### Key Concept: Blocks

- Fixed size: 4096 bytes (default)
- Each block has unique `blockId` (number)
- Blocks can be allocated, freed, reused

### Main Operations

- `allocateBlock()` - Get a new unique block ID
- `writeBlock(blockId, data)` - Write data to block
- `readBlock(blockId)` - Read block contents
- `freeBlock(blockId)` - Mark block as reusable
- `flush()` - Sync to disk

### Internal Structure

```
File Layout:
┌──────────────────────┐
│  Metadata Block (0)  │  blockId=0
├──────────────────────┤
│   User Data (1)      │  blockId=1
├──────────────────────┤
│   User Data (2)      │  blockId=2
├──────────────────────┤
│   Free List Metadata │
├──────────────────────┤
│   ...more blocks...  │
└──────────────────────┘

Free Block List:
┌──────────────────────┐
│ blockId → isFree?    │
│ Bit vector or linked │
│ list of free blocks  │
└──────────────────────┘
```

### Fragmentation & Compaction

Over time, deleted blocks create **fragmentation**:

```
Initial:  [A] [B] [C] [D]   (all allocated)
Delete B: [A] [X] [C] [D]   (B is free)
Delete A: [X] [X] [C] [D]   (A, B free but scattered)

Fragmentation ratio: 50%
```

**Solution**: Compaction rewrites data, skipping free blocks.

```
Compact:  [C] [D] [E] [F]   (contiguous)
          File shrinks or reuses free space
```

## NodeStorage

Abstracts where B+ tree nodes live.

### Interface

NodeStorage provides: `createNode()`, `readNode()`, `writeNode()`, `deleteNode()`, `flush()`.

### Implementations

- **FBNodeStorage** - Disk-backed (uses FreeBlockFile blocks)
- **TrivialNodeStorage** - In-memory (for testing)

### LRU Cache Layer

Wraps `FBNodeStorage` to cache hot nodes in memory. Configurable max size (default: ~100MB).

**Statistics**: Track hits, misses, evictions, and hit rate via `getStats()`.

## Usage Stack

The storage layer is built as a stack from bottom to top:

1. **RealFile** (disk I/O)
2. **FreeBlockFile** (page allocator)
3. **FBNodeStorage** (node storage)
4. **LRUCache** (hot node caching)

## Performance Characteristics

| Operation               | Time          | Notes                             |
| ----------------------- | ------------- | --------------------------------- |
| Allocate block          | O(1)          | Amortized; may trigger compaction |
| Free block              | O(1)          | Mark in free list                 |
| Read block (cache hit)  | O(1)          | Memory access                     |
| Read block (cache miss) | O(1) disk I/O | 4KB read from disk                |
| Write block             | O(1) disk I/O | 4KB write to disk                 |
| Flush                   | O(1)          | fsync to disk                     |

## Cache Tuning

Larger cache reduces disk reads but uses more memory. Target: >90% hit rate in production.

## Common Issues

### Issue: Disk Full During Compaction

**Problem**: Compaction needs 2X space temporarily (original + new file).

**Solution**: Ensure at least 2X free disk space before compacting.

### Issue: Slow Writes

**Problem**: Disk I/O is the bottleneck.

**Solution**:

1. Increase LRU cache size
2. Batch inserts together (reduces flushes)
3. Use faster disk (SSD > HDD)

### Issue: Memory Leak

**Problem**: Cache grows unbounded.

**Solution**: Monitor `cache.getStats()`, tune `maxSize` parameter.

## Design Decisions

### Why Blocks?

1. **Disk Efficiency**: OS pages are typically 4KB; matches hardware
2. **Reuse**: Free blocks can be reused without file defragmentation
3. **Predictability**: Fixed-size pages simplify allocation

### Why LRU Cache?

B+ tree access patterns are **heavily skewed**:

- Root node accessed 100% of tree operations
- Upper levels accessed frequently
- Leaf nodes accessed less often

LRU cache exploits this: hot nodes stay in memory, cold nodes on disk.

### Why Separate FreeBlockFile from Nodes?

**Separation of concerns**:

- `File` handles raw byte I/O
- `FreeBlockFile` adds page/block abstraction
- `NodeStorage` adds tree-node semantics
- Application code (SimpleDBMS) doesn't know about blocks or files

Each layer can be tested, swapped, or optimized independently.

## Testing

```bash
# File interface tests
npm test -- src/storage/file/file.spec.mts

# FreeBlockFile tests
npm test -- src/storage/freeblockfile.spec.mts

# NodeStorage tests
npm test -- src/storage/node-storage/*.spec.mts
```

## References

- [Core Module](../core/README.md) - Uses storage layer
- [Indexes](../indexes/README.md) - Stores B+ tree nodes via storage layer
- [Full Architecture](../../docs/ARCHITECTURE.md)
