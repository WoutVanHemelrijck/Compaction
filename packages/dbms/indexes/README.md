# B+ Tree Index (`src/indexes/`)

Efficient multi-key index supporting fast lookups, range queries, and ordered iteration.

## Contents

- **`b-plus-tree.mts`** - Main B+ tree implementation
- **`b-plus-tree.spec.mts`** - Comprehensive tests
- **`btree.mts`** - Alternative B-tree variant (older)

## Quick Start

B+ tree operations: `init()`, `insert(key, value)`, `search(key)`, `delete(key)`, `update(key, value)`, `rangeQuery(min, max)`.

Use with a storage implementation (e.g., `FBNodeStorage`).

## B+ Tree Properties

| Property           | Value                             |
| ------------------ | --------------------------------- |
| **Structure**      | Tree with multi-way branches      |
| **Order**          | Configurable (default 100)        |
| **Leaf Nodes**     | Store actual key-value pairs      |
| **Internal Nodes** | Store keys + child pointers       |
| **Balanced**       | All leaves at same depth          |
| **Linked Leaves**  | Sequential scan without recursion |

## Example Tree (Order=3, Simplified)

```
            [50]
           /    \
        [20]   [60, 80]
       /  |  \   /  |  \
    [10][15][30] [55][70][90]

Insert rules:
- Each leaf holds ≤ order keys
- If overflow: split and promote middle key
- Maintain balance by cascading splits up
```

## API

### Constructor

Takes NodeStorage instance and order (default 100 keys per node).

### Core Operations

- `init()` - Initialize tree (create root)
- `insert(key, value)` - Insert key-value pair
- `search(key)` - Search for value (returns null if not found)
- `delete(key)` - Delete by key
- `update(key, value)` - Update value for existing key
- `rangeQuery(min, max)` - Range query
- `getIterator()` - Sequential scan of all entries

### Transactions (Experimental)

Transaction support: `beginTransaction()`, `commitTransaction()`, `abortTransaction()`.

## Complexity Analysis

| Operation   | Time         | Space          |
| ----------- | ------------ | -------------- |
| Insert      | O(log N)     | O(1) amortized |
| Search      | O(log N)     | O(log N) stack |
| Delete      | O(log N)     | O(log N) stack |
| Range query | O(log N + K) | O(K) result    |
| Scan all    | O(N)         | O(1) iterator  |

Where N = total keys, K = result size.

## Internal Details

### Node Types

#### **Leaf Node**

```typescript
interface LeafNode {
  keys: Key[]; // Sorted keys
  values: Value[]; // Corresponding values
  next: NodeId; // Link to next leaf
  isLeaf: true;
}
```

#### **Internal Node**

```typescript
interface InternalNode {
  keys: Key[]; // Separators
  children: NodeId[]; // Child node IDs
  isLeaf: false;
}
```

### Insertion with Overflow

```
Insert (15) into leaf [10, 20, 30]:
  1. Find position: between 10 and 20
  2. Insert: [10, 15, 20, 30]
  3. Check: size (4) > order (3) → overflow!
  4. Split into:
     - Left leaf: [10, 15]
     - Right leaf: [20, 30]
     - Promote key 15 to parent
  5. If parent overflows, recursively split up
```

### Deletion with Underflow

```
Delete key from leaf with few keys:
  1. Remove key
  2. Check: size < order/2 → underflow!
  3. Try borrow from sibling:
     - If sibling has spare key → rebalance
     - Else: merge with sibling
  4. Propagate merge up if parent underflows
```

## Performance Tuning

### Order Selection

```typescript
// Small order (10-20) → shallow tree, tall nodes
// Large order (100-500) → deeper tree, fewer nodes
const tree = new BPlusTree(storage, (order = 100));
```

**Recommendation**: Order should match node size to block size.

- If block = 4KB, key+value ≈ 50 bytes each
- Max keys per node ≈ 4000 / 50 = 80
- Choose order = 50-100

### Batch Operations

```typescript
// Instead of:
for (const doc of docs) {
  await tree.insert(doc.id, doc); // N separate inserts
}

// Use batch insert (internal logic):
// - Collects insertions
// - Defers tree rebalancing
// - Faster overall
```

## Key Comparisons

Indexes should be created on fields that:

1. Are **frequently queried** (WHERE clauses)
2. Have **high selectivity** (few duplicates)
3. Are **immutable** or rarely updated

Example: Index on `email` (unique), not on `age` (low selectivity).

## Testing

```bash
npm test -- src/indexes/b-plus-tree.spec.mts

# Benchmark
npm run bench:b-plus-tree

# Profile (optional)
node --prof build/indexes/b-plus-tree-bench.mjs
node --prof-process isolate-*.log > profile.txt
```

## Limitations & Future Work

1. **No Composite Keys** - Currently single-key indexes
   - Future: Multi-field indexes like `(lastName, firstName)`

2. **No Partial Indexes** - All records must be indexed
   - Future: Index only rows matching a predicate

3. **No Covering Indexes** - Must access original table for values
   - Future: Store leaf node values without table lookup

4. **No Concurrent Access** - Single-threaded only
   - Future: Latch-free B+ trees for multi-threaded workloads

## References

- [Storage Layer](../storage/README.md) - How nodes are persisted
- [Core Database](../core/README.md) - Uses indexes for fast queries
- [Query Optimizer](../query-language/README.md) - Selects which indexes to use
- [Full Architecture](../../docs/ARCHITECTURE.md) - System overview
