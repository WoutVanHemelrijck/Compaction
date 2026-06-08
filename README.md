# SimpleDBMS

A comprehensive relational database management system implemented in TypeScript, built from scratch as part of a university coursework project (P&O 2025-2026). This system demonstrates a complete implementation of core DBMS concepts including indexing, query processing, persistence, compression, distributed consensus, and natural language interfaces.

## Project Overview

SimpleDBMS is a full-featured database system that provides:

- **B+ Tree Indexing** - Efficient data retrieval and sorting
- **Query Language Engine** - SQL-like syntax with natural language support
- **Persistence Layer** - File-based storage with crash recovery (WAL)
- **Compression** - Automatic payload compression with multiple algorithms
- **Database Compaction** - Automatic garbage collection and space optimization
- **NLP/Vector Search** - Semantic search using HNSW approximate nearest-neighbor index and n-gram search
- **RAG Integration** - Retrieval-augmented generation with Claude API
- **Distributed Consensus** - Raft-based replication for distributed deployments
- **REST API Server** - Express-based HTTP daemon with authentication
- **Web Frontend** - Browser-based UI for database interaction

## Architecture Overview

```
┌──────────────────────────────────────┐
│   Distributed Consensus (Raft)       │  Replication & cluster coordination
├──────────────────────────────────────┤
│       Frontend / REST API            │  Web UI + HTTP endpoints
├──────────────────────────────────────┤
│    Query Engine & Interpreter        │  SQL/Natural Language parsing
├──────────────────────────────────────┤
│  NLP / Vector Search / RAG Agent     │  Semantic queries
├──────────────────────────────────────┤
│   SimpleDBMS Core Engine             │  Main database engine
├──────────────────────────────────────┤
│  Index Layer (B+ Tree) + Storage     │  Data structures
├──────────────────────────────────────┤
│ Durability Layer (WAL, Compaction)   │  Crash recovery, cleanup
├──────────────────────────────────────┤
│  Storage Primitives (File, Pages)    │  Low-level I/O
└──────────────────────────────────────┘
```

## Monorepo Structure

This is a **monorepo** organized with npm workspaces. All code is organized into logical packages and applications:

```
packages/                              Reusable libraries
├── raft-core/                         Raft consensus algorithm
├── raft-grpc/                         gRPC transport for Raft
├── query-language/                    SQL parser & executor
├── auth/                              Authentication & encryption
├── nlp/                               NLP & vector search
├── dbms/                              Database management system modules
│   ├── core/                          SimpleDBMS engine
│   ├── storage/                       File I/O & block allocation
│   ├── indexes/                       B+ tree indexing
│   ├── durability/                    WAL, compaction, compression
│   └── big-data-import/               Bulk import pipeline

apps/                                  End-user applications
├── api-server/                        REST API server
├── frontend/                          Web UI
├── raft-viz/                          Raft cluster visualizer
├── raft-demo-runner/                  Raft demo cluster
└── benchmarks/                        Performance benchmarks

docs/                                  Documentation
├── REPOSITORY_STRUCTURE.md                    Detailed architecture guide
└── RAFT.md                            Raft implementation details

scripts/                               Utility scripts
└── debug/                             Debugging utilities
```

## Getting Started

### Prerequisites

- Node.js 18+ with npm

### Installation

```bash
npm install
```

### Running the Server

From the root directory:

```bash
npm run dev
```

Starts the SimpleDBMS daemon on `http://localhost:3000` with:

- REST API on `/api/`
- Swagger documentation on `/api-docs`
- Web UI on `/`

Or run a specific app:

```bash
cd apps/api-server && npm run dev
```

### Running Tests

```bash
npm test                    # Run all tests
npm run coverage            # Generate coverage report
npm run test:nlp            # NLP-specific tests
```

### Building

```bash
npm run build               # Compile TypeScript to JavaScript
npm run lint                # Check code style
npm run lint-fix            # Auto-fix style issues
npm run prettier-fix        # Format code
```

## Key Features

### 1. **Core Storage Engine** (`packages/dbms/core`)

The main `SimpleDBMS` class assembles all subsystems. Handles:

- Collection management (create, drop, list)
- Document CRUD operations
- Transaction support (begin, commit, rollback)
- Index creation and management
- Secondary indexes for fast lookups

### 2. **Storage Layer** (`packages/dbms/storage`)

Low-level storage primitives:

- **File Abstraction** - Generic interface for disk I/O
- **FreeBlockFile** - Page-based allocator with block reuse
- **NodeStorage** - Abstractions for B+ tree nodes (LRU cache for performance)

### 3. **B+ Tree Indexing** (`packages/dbms/indexes`)

Efficient multi-dimensional index:

- Configurable order and key/value types
- Insertion, deletion, range queries
- Automatic node splitting and merging
- Performance benchmarks included

### 4. **Durability & Recovery** (`packages/dbms/durability`)

Ensures data safety:

- **Write-Ahead Log (WAL)** - Records all mutations before applying them
- **Compaction** - Garbage collects free blocks and rewrites DB
- **Compression** - Automatically compresses stored payloads (zstd, etc.)
- **Auto-compaction** - Triggers cleanup when fragmentation exceeds threshold

### 5. **Query Engine** (`packages/query-language/`)

Full SQL-like language support:

- Lexer → Parser → AST → Executor pipeline
- SELECT, INSERT, UPDATE, DELETE operations
- WHERE clause filtering with predicates
- JOIN operations (inner, left, right, full)
- Query optimization (predicate pushdown, index selection)
- **Natural Language Executor** - Converts English to SQL

### 6. **NLP & Vector Search** (`packages/nlp/`)

Semantic search capabilities:

- **N-gram Indexing** - Full-text search on indexed fields
- **HNSW Index** - Approximate nearest-neighbor search for vector embeddings
- Text embedding via HuggingFace Transformers
- Fast similarity-based document retrieval

### 7. **RAG Agent** (`packages/nlp/rag/`)

LLM-powered database interaction:

- LangChain integration with Claude API
- Tools for querying the database via natural language
- Memory-based conversation context
- Multi-turn dialogue support

### 8. **Distributed Consensus** (`packages/raft-core && packages/raft-grpc`)

Raft protocol implementation:

- Core Raft algorithm (leader election, log replication)
- gRPC transport layer
- State machine abstraction
- DevTools UI for cluster visualization

## Development Guide

### Running Individual Benchmarks

```bash
# Compression benchmarks
npm run bench:compression
npm run bench:compression:quick
npm run bench:compression:csv

# Search optimization benchmarks
npm run bench:search-opt
npm run bench:search-opt:save
npm run bench:search-opt:compare

# Wiki bulk import (large dataset)
npm run wiki-import

# Database reset
npm run reset-db
```

### Adding a New Package

1. Create a folder in `packages/<module-name>/`
2. Add a `package.json` with appropriate dependencies
3. Add a `README.md` explaining the package
4. Implement functionality with `.mts` (TypeScript) files
5. Add corresponding `.spec.mts` test files
6. Export public APIs from `index.mts`
7. Update `package.json` in dependent packages
8. Run `npm install` at root to link workspaces

### Testing

- **Unit tests** in `*.spec.mts` files
- **Integration tests** in `tests/` subdirectories
- **Vitest** with single-worker mode for consistency
- **Coverage reports** generated to `coverage/` directory

## Performance

See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for performance characteristics and optimization decisions.

## Team & Attribution

- **Authors**: Maarten Haine, Jari Daemen, Frederick Hillen, Tijn Gommers, Wout Van Hemelrijck, William Ragnarsson, Mathias Bouhon Keulen and Arwin Gorissen
- **Date**: November 2025 - May 2026
- **Coursework**: P&O (Programming & Organization) 2025-2026
- **Institution**: KU Leuven - department: Computer Science

## License

ISC

---
