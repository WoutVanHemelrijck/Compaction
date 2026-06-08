# Durability Layer (`src/durability/`)

Ensures data survives crashes, provides atomic operations, and reclaims disk space.

## Contents

- **`atomic-operations/`** - Write-Ahead Log (WAL)
  - `atomic-file.mts` - Atomic file writes
  - `wal-manager.mts` - Crash recovery

- **`compaction/`** - Space reclamation
  - `compaction.mts` - Manual/automatic database shrink
  - `auto-compaction.mts` - Background cleanup
  - `rw-lock.mts` - Coordination lock

- **`compression/`** - Payload compression
  - `compression.mts` - Multiple compression algorithms
  - `envelope.mts` - Serialization format

## Write-Ahead Log (WAL)

### Concept

Before changing database, **write intent to log**. On crash, replay log to recover.

### How It Works

```
Client: INSERT alice
  ↓
1. WAL Manager: append {INSERT, alice} to log
2. fsync (disk confirmation)
3. Apply to database
4. Store undo info

On crash:
1. Open log
2. Replay all committed ops
3. Discard uncommitted ops
```

### Usage

Before write operations:

1. Log operation to WAL
2. fsync to disk for durability
3. Apply to database
4. Store undo information for rollback

On crash:

1. Call `wal.recover()`
2. Replays all logged operations
3. Returns database to last consistent state

### Guarantees

- **Atomicity**: Transaction either fully applied or not at all
- **Durability**: fsync ensures written data is on disk
- **Consistency**: Invariants maintained after recovery
- **Isolation**: Single-threaded execution

## Atomic File Operations

Wraps the File interface to ensure writes are atomic using copy-on-write:

1. Write to temporary file
2. Atomic rename to target (OS-level guarantee)
3. On crash: original file unchanged, temporary file cleaned up

## Compaction

### Problem

```
Initial file:
[Alice] [Bob] [Charlie]

Delete Bob:
[Alice] [DELETED] [Charlie]

After 100 such deletes:
~50% of disk is wasted
```

### Solution

Call `compactDatabase(db)` to rewrite the database, skipping deleted documents and reducing file size by 30-70%.

### How It Works

```
1. Open new output file
2. Iterate all collections
3. For each live document, re-insert into new file
4. Rebuild all indexes on new data
5. Atomic swap: old file → new file
6. Delete old file

Cost: O(N) time, 2X space temporarily
Benefit: Reclaimed ~50% disk space
```

### Auto-Compaction

Triggered automatically when fragmentation exceeds threshold:

```typescript
// Enable auto-compaction
process.env.AUTO_COMPACTION_THRESHOLD = '50'; // Trigger at 50% fragmented

// Auto-compaction runs in background
// Doesn't block user queries
// Adaptive: more aggressive as fragmentation increases
```

## Compression

### Algorithm Selection

Supported algorithms: zstd (default), none (no compression). Set via `COMPRESSION_ALGORITHM` environment variable.

### Compression Flow

1. **On write**: Compress document, store compressed data
2. **On read**: Retrieve compressed data, decompress before use

### Envelope Format

```
[Compressed Payload]
├─ Magic: "DBH1" (4 bytes) - Identifies compressed data
├─ Algorithm: 1 byte (0=zstd, 1=none)
├─ Original Size: 4 bytes (for allocation)
├─ Compressed Size: 4 bytes (for reading)
└─ Compressed Data: [variable] - Actual payload
```

### Compression Ratios

| Data Type                     | Ratio                |
| ----------------------------- | -------------------- |
| JSON documents                | 40-60% (2-2.5X)      |
| Text/HTML                     | 20-40% (2.5-5X)      |
| Binary                        | 80-95% (1.05-5X)     |
| Already compressed (PNG, ZIP) | 95-100% (no benefit) |

**Recommendation**: Enable compression for text-heavy databases, disable for already-compressed data.

## Coordinated Access (RW-Lock)

Reader-writer lock coordinates concurrent access during compaction:

- **Read lock**: Multiple readers can hold simultaneously
- **Write lock**: Exclusive access for compaction operations

## Testing

```bash
# WAL recovery
npm test -- src/durability/atomic-operations/wal-manager.spec.mts

# Compaction
npm test -- src/durability/compaction/compaction.spec.mts

# Compression
npm test -- src/durability/compression/compression.spec.mts

# Benchmarks
npm run bench:compression
```

## Configuration

Environment variables:

```bash
# Compression
COMPRESSION_ALGORITHM=zstd          # Algorithm to use
COMPRESSION_THRESHOLD=1000          # Compress payloads > 1KB

# Auto-compaction
AUTO_COMPACTION_THRESHOLD=50        # Trigger at 50% fragmentation
AUTO_COMPACTION_CHECK_INTERVAL=60000  # Check every 60s

# Debug
DEBUG=simpledbms:durability         # Enable detailed logging
```

## Common Issues

### Issue: Out of Disk During Compaction

Compaction temporarily needs **2X** disk space:

- Solution: Ensure at least 2X free space before compacting

### Issue: Slow Writes Due to Compression

Compression adds CPU cost:

- Solution: Profile; disable if CPU is bottleneck
- Use faster CPU or batch writes

### Issue: Incomplete Recovery After Crash

May happen if:

- WAL file corrupted (disk failure)
- fsync didn't actually sync (buggy driver)
- Solution: Maintain backups; test recovery regularly

## Design Decisions

### Why WAL?

**Alternatives**:

- In-place updates (risky, hard to recover)
- Logging after (slow, not crash-safe)
- WAL (fast + safe) ✓

### Why Separate Compression?

Decoupling compression from storage allows:

- Easy algorithm swaps
- Testing with/without compression
- Gradual adoption (compress new writes only)

### Why Auto-Compaction?

Manual compaction requires DBA intervention. Auto-compaction:

- Reduces operational burden
- Adapts to workload (frequent deletes → more aggressive)
- Background execution (non-blocking)

## References

- [Storage Layer](../storage/README.md) - Low-level I/O
- [Core Database](../core/README.md) - Uses durability features
- [Full Architecture](../../docs/ARCHITECTURE.md)
