# SimpleDBMS Repository Structure (Monorepo Edition)

## Overview

SimpleDBMS is organized as a **monorepo** with npm workspaces, separating independent packages and applications for better organization and clarity.

---

## Root Level Files

```
├── README.md                       Main project documentation
├── REPOSITORY_STRUCTURE.md         This file
├── RAFT-LICENSE.md                 Raft implementation license
├── package.json                    Root workspaces config
├── package-lock.json               Dependency lock
├── tsconfig.json                   TypeScript configuration
├── tsconfig.base.json              Base TypeScript config
├── vitest.config.ts                Test runner configuration
├── .prettierrc.json                Code formatting rules
└── .vscode/                        VS Code settings
```

---

## packages/ - Reusable Libraries

### Raft Consensus

```
packages/raft-core/
├── src/                            Source code
│   ├── core/                       Raft algorithm implementation
│   ├── state/                      Node state machines
│   ├── storage/                    Log and state storage
│   ├── rpc/                        RPC message handling
│   ├── timing/                     Election timeout logic
│   ├── snapshot/                   Snapshotting
│   ├── events/                     Event system
│   ├── lock/                       Concurrency locks
│   ├── log/                        Log management
│   ├── config/                     Configuration
│   ├── transport/                  Transport layer
│   └── util/                       Utilities
├── dist/                           Compiled output
├── package.json                    Package metadata
└── *.spec.ts                       Tests

packages/raft-grpc/
├── src/                            Source code
├── proto/                          Protocol buffer definitions
├── dist/                           Compiled output
├── package.json                    Package metadata
└── *.spec.ts                       Tests
```

### Query Language

```
packages/query-language/
├── src/                            Source code
│   ├── lexer/                      Tokenization
│   │   └── lexer.mts
│   ├── parser/                     SQL parsing
│   │   ├── parser.mts
│   │   ├── expression-parser.mts
│   │   ├── value-parser.mts
│   │   ├── parser-cursor.mts
│   │   └── parser-helpers.mts
│   ├── interpreter/                Query execution
│   │   ├── interpreter.mts
│   │   └── nl.mts                  Natural language processing
│   ├── executors/                  Operation executors
│   │   ├── select.mts
│   │   ├── insert.mts
│   │   ├── update.mts
│   │   ├── delete.mts
│   │   ├── join.mts
│   │   ├── select-optimizer.mts
│   │   └── storage-adapter-helpers.mts
│   └── types/                      Type definitions
│       ├── ast-nodes.mts
│       ├── ast-operations.mts
│       ├── tokens.mts
│       ├── execution-results.mts
│       └── index.mts
├── storage-adapter/                Storage abstraction
│   ├── storage-adapter.mts
│   ├── storage-adapter-types.mts
│   ├── in-memory-storage-adapter.mts
│   └── simpledbms-storage-adapter.mts
├── tests/                          Comprehensive tests (1000+)
│   ├── query-language/
│   │   ├── executors/
│   │   ├── interpreter/
│   │   ├── lexer.spec.mts
│   │   └── parser/
│   └── storage-adapter/
├── GRAMMAR.ebnf                    Query grammar
├── AI_QUERY_LANGUAGE_SPEC.md       Language specification
├── package.json                    Package metadata
└── tsconfig.json                   TypeScript config
```

### Authentication & Security

```
packages/auth/
├── authentication.mts              Auth implementation
├── authentication.spec.mts         Tests
├── password-hashing.mts            Password hashing
├── password-hashing.spec.mts       Tests
├── encryption-service.mts          Encryption utilities
├── encryption-service.spec.mts     Tests
```

### NLP & Vector Search

```
packages/nlp/
├── ngrams/                         N-gram indexing
│   ├── ngram-index.mts
│   ├── ngram-index.spec.mts
│   ├── search-engine.mts           N-gram search
│   ├── search-engine.spec.mts
│   ├── ngrams-bench.mts            Benchmarks
│   ├── filterwords/                Stopwords
│   └── tools/
│       ├── ngram.mts               Utilities
│       ├── ngram.spec.mts
│       ├── filters-streamify.mts
│       └── filters-streamify.spec.mts
├── text-embedding/                 Vector search
│   ├── hnsw-index.mts              HNSW index
│   ├── hnsw-index.spec.mts
│   ├── find-similar.mts            Similarity search
│   ├── find-similar.spec.mts
│   ├── disk-storage.mts            Persistent storage
│   ├── disk-storage.spec.mts
│   ├── node.mts                    HNSW node
│   ├── max-heap.mts                Priority queue
│   ├── max-heap.spec.mts
│   └── nls-bench.mts               Benchmarks
└── package.json                    Package metadata
```

### DBMS Package (Umbrella)

All database management system modules organized under a single package:

```
packages/dbms/
├── core/                           SimpleDBMS Engine
│   ├── simpledbms.mts              Main engine class
│   ├── simpledbms.spec.mts         Unit tests
│   ├── trivialdbms.mts             Simplified prototype
│   ├── trivialdbms.test.mts        Prototype tests
│   ├── invariants.mts              Consistency checks
│   ├── debug-global-constants.mts  Debug utilities
│   ├── test.mts                    Integration tests
│   └── README.md                   Documentation
│
├── storage/                        Storage Layer
│   ├── freeblockfile.mts           Page-based allocator
│   ├── freeblockfile.spec.mts      Tests
│   ├── file/                       File abstraction
│   │   ├── file.mts                Generic interface
│   │   ├── file.spec.mts           Tests
│   │   └── mockfile.mts            In-memory implementation
│   ├── node-storage/               Node storage abstraction
│   │   ├── node-storage.mts        Interface
│   │   ├── node-storage.spec.mts   Tests
│   │   ├── fb-node-storage.mts     Disk-backed implementation
│   │   ├── fb-node-storage.spec.mts Tests
│   │   ├── trivial-node-storage.mts In-memory implementation
│   │   ├── trivial-node-storage.spec.mts Tests
│   │   ├── LRU-cache.mts           Caching layer
│   │   └── LRU-cache.spec.mts      Tests
│   ├── package.json                Package metadata
│   └── README.md                   Documentation
│
├── indexes/                        B+ Tree Indexing
│   ├── b-plus-tree.mts             Main B+ tree
│   ├── b-plus-tree.spec.mts        Tests
│   ├── btree.mts                   Alternative implementation
│   ├── package.json                Package metadata
│   └── README.md                   Documentation
│
├── durability/                     WAL, Compaction, Compression
│   ├── atomic-operations/          Write-ahead log
│   │   ├── atomic-file.mts         Atomic file writes
│   │   ├── atomic-file.spec.mts    Tests
│   │   ├── wal-manager.mts         WAL manager
│   │   └── wal-manager.spec.mts    Tests
│   ├── compaction/                 Database compaction
│   │   ├── compaction.mts          Compaction logic
│   │   ├── compaction.spec.mts     Tests
│   │   ├── auto-compaction.mts     Automatic cleanup
│   │   ├── auto-compaction.spec.mts Tests
│   │   ├── rw-lock.mts             Reader-writer lock
│   │   └── rw-lock.spec.mts        Tests
│   ├── compression/                Payload compression
│   │   ├── compression.mts         Compression algorithms
│   │   ├── compression.spec.mts    Tests
│   │   ├── envelope.mts            Serialization format
│   │   ├── envelope.spec.mts       Tests
│   │   └── ENVELOPE_SCHEMA.md      Format documentation
│   ├── package.json                Package metadata
│   └── README.md                   Documentation
│
└── big-data-import/                Bulk Import Pipeline
    ├── wiki-import.mts             Wikipedia importer
    ├── wiki-import.spec.mts        Tests
    └── package.json                Package metadata
```

---

## apps/ - End-User Applications

### api-server (REST API)

```
apps/api-server/
├── simpledbmsd.mts                 Main server
├── simpledbmsd.spec.mts            Server tests
├── proxy.mts                       Request proxy
├── application.mts                 Application harness
├── spawnOne.mts                    Single node launcher
├── spawnMany.mts                   Multi-node launcher
└── README.md                       API documentation
```

### frontend (Web UI)

```
apps/frontend/
├── scripts/                        Client-side scripts
│   ├── login.mts
│   ├── signup.mts
│   ├── documents.mts
│   ├── dashboard.mts
│   ├── webclient.mts
│   └── utils.mts
├── components/                     UI components
├── styles/                         CSS stylesheets
├── package.json                    Package metadata
└── README.md                       Documentation
```

### raft-viz (Cluster Visualizer)

```
apps/raft-viz/
├── src/                            Source code
│   ├── components/                 React components
│   ├── hooks/                      React hooks
│   ├── store/                      State management
│   ├── constants/                  Configuration
│   └── types/                      TypeScript types
├── dist/                           Built UI
├── package.json                    Package metadata
└── tsconfig.json                   TypeScript config
```

### raft-demo-runner (Demo Cluster)

```
apps/raft-demo-runner/
├── src/                            Source code
├── dist/                           Compiled output
├── package.json                    Package metadata
└── (configuration files)
```

### benchmarks (Performance Tests)

```
apps/benchmarks/
├── b-plus-tree-bench.mts           B+ tree performance
├── compression-algorithm-bench.mts Compression benchmarks
├── fb-node-storage-bench.mts       Storage performance
├── search-optimization-bench.mts   Query optimization
├── auto-compaction-bench.mts       Compaction performance
```

---

## docs/ - Documentation

```
docs/
├── ARCHITECTURE.md                 System architecture guide
├── RAFT.md                         Raft consensus details
└── curls.txt                       API testing examples
```

---

## scripts/ - Utilities

```
scripts/
└── debug/
    ├── debug_compaction.mts        Compaction debugger
    └── repro_snapshot.mts          Snapshot reproducer
```

---

## data/ - Data Files

```
data/
└── dummy-account.json              Test account data
```

---

## Key Statistics

- **Total TypeScript Files**: 200+
- **Test Files**: 100+ (\*.spec.mts)
- **Lines of Code**: 50,000+
- **Packages**: 7 (raft-core, raft-grpc, query-language, auth, nlp, dbms, with dbms containing 5 sub-modules)
- **Applications**: 5
- **Total Directories**: 16

---

## Monorepo Features

### npm Workspaces

- All packages linked automatically
- Shared dependencies at root
- `npm install` installs everything
- `npm run build` builds all packages
- `npm test` runs all tests

### Package Organization

- Each package is independently buildable
- Clear separation of concerns
- Easy to understand relationships
- Self-contained with documentation

---

## Architecture Layers

```

Distributed Consensus (Raft)
↓
Application Layer (API + UI)
↓
Query Engine (SQL/NL parsing)
↓
NLP & Semantic Search
↓
SimpleDBMS Core Engine
↓
Indexing Layer (B+ Tree)
↓
Durability Layer (WAL/Compression)
↓
Storage Primitives (File I/O)

```

---

## For Quick Navigation

| Want to Understand | Look at                        |
| ------------------ | ------------------------------ |
| Overall system     | README.md                      |
| Engine logic       | packages/dbms/core/            |
| Storage system     | packages/dbms/storage/         |
| Indexing           | packages/dbms/indexes/         |
| Bulk import        | packages/dbms/big-data-import/ |
| Durability         | packages/dbms/durability/      |
| Query processing   | packages/query-language/       |
| API server         | apps/api-server/               |
| Web UI             | apps/frontend/                 |
| Raft consensus     | packages/raft-core/            |
| NLP/vectors        | packages/nlp/                  |
| Authentication     | packages/auth/                 |

---

**Last Updated**: May 2026
**Project**: SimpleDBMS

```

```
