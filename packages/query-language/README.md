# Querylib

Querylib is a lightweight SQL-like query engine written in TypeScript. It includes a full query pipeline from lexical analysis to execution, plus an optional natural-language layer powered by OpenAI.

This project is designed for:

- building and experimenting with a custom query language
- running query operations against an in-memory dataset
- integrating with a pluggable storage adapter abstraction
- extending parser and executor behavior in a test-first workflow

## Highlights

- End-to-end query pipeline: lexer -> parser -> AST -> interpreter -> executors
- Statement support: SELECT, DELETE, INSERT, UPDATE
- Optional storage adapter integration for read/write/filter/project/delete/update
- In-memory storage adapter implementation for local development and tests
- SELECT optimizer with relational rewrite stages
- Natural-language execution path via OpenAI chat completions
- Comprehensive Vitest test suite across lexer, parser, interpreter, executors, optimizer, and storage adapter

## Supported Query Features

- WHERE expressions with precedence and parenthesis handling
- Logical operators: AND, OR, NOT
- Comparison operators: =, !=, >, >=, <, <=
- IN lists
- IS NULL and IS NOT NULL
- Arithmetic expressions: +, -, \*, /
- DISTINCT
- ORDER BY with ASC and DESC
- LIMIT and OFFSET
- JOIN forms in parsing/execution metadata: INNER, LEFT, RIGHT, OUTER, CROSS
- Aggregate functions in SELECT and HAVING parsing: COUNT, SUM, AVG, MIN, MAX

## Grammar

The canonical grammar for currently supported parser behavior is defined in
[GRAMMAR.ebnf](GRAMMAR.ebnf).

Use [AI_QUERY_LANGUAGE_SPEC.md](AI_QUERY_LANGUAGE_SPEC.md) for generation guidance and constraints.

Current execution notes:

- Non-grouped aggregate execution is implemented
- GROUP BY and HAVING are parsed, but full grouped aggregate execution semantics are not fully implemented yet

## Architecture Overview

Main source layout:

- [src/query-language/src/lexer/lexer.mts](src/query-language/src/lexer/lexer.mts)
- [src/query-language/src/parser/parser.mts](src/query-language/src/parser/parser.mts)
- [src/query-language/src/parser/expression-parser.mts](src/query-language/src/parser/expression-parser.mts)
- [src/query-language/src/parser/value-parser.mts](src/query-language/src/parser/value-parser.mts)
- [src/query-language/src/parser/parser-cursor.mts](src/query-language/src/parser/parser-cursor.mts)
- [src/query-language/src/interpreter/interpreter.mts](src/query-language/src/interpreter/interpreter.mts)
- [src/query-language/src/interpreter/nl.mts](src/query-language/src/interpreter/nl.mts)
- [src/query-language/src/executors/select.mts](src/query-language/src/executors/select.mts)
- [src/query-language/src/executors/select-optimizer.mts](src/query-language/src/executors/select-optimizer.mts)
- [src/query-language/src/executors/delete.mts](src/query-language/src/executors/delete.mts)
- [src/query-language/src/executors/insert.mts](src/query-language/src/executors/insert.mts)
- [src/query-language/src/executors/update.mts](src/query-language/src/executors/update.mts)
- [src/query-language/src/executors/join.mts](src/query-language/src/executors/join.mts)
- [src/storage-adapter/storage-adapter.mts](src/storage-adapter/storage-adapter.mts)
- [src/storage-adapter/in-memory-storage-adapter.mts](src/storage-adapter/in-memory-storage-adapter.mts)

Execution flow:

1. Lexer tokenizes raw query text
2. Parser constructs a typed AST
3. Interpreter dispatches by statement type
4. Statement executor performs operation (in-memory and or storage-adapter-backed)

## Installation

Requirements:

- Node.js 18 or newer

Install dependencies:

```bash
npm install
```

## Quick Start

Example using the interpreter directly:

```ts
import { Interpreter } from './src/query-language/src/interpreter/interpreter.mts';

const query = 'SELECT NAME FROM USERS WHERE ACTIVE = 1';
const interpreter = new Interpreter(query);

const result = await Promise.resolve(interpreter.execute());
console.log(result);
```

Why Promise.resolve is used:

- some executors can return sync results
- storage-adapter-backed paths may return Promise results

Using the in-memory storage adapter:

```ts
import { Interpreter } from './src/query-language/src/interpreter/interpreter.mts';
import { InMemoryStorageAdapter } from './src/storage-adapter/in-memory-storage-adapter.mts';

const adapter = new InMemoryStorageAdapter({
  USERS: [
    { ID: 1, NAME: 'Alice', ACTIVE: 1 },
    { ID: 2, NAME: 'Bob', ACTIVE: 0 },
  ],
});

const interpreter = new Interpreter('SELECT NAME FROM USERS WHERE ACTIVE = 1', adapter);
const result = await Promise.resolve(interpreter.execute());

console.log(result.rows);
```

## Natural Language Layer (OpenAI)

Querylib includes a natural-language wrapper in [src/query-language/src/interpreter/nl.mts](src/query-language/src/interpreter/nl.mts).

Behavior summary:

- sends user prompt to OpenAI chat completions
- asks for a single SQL-like query string response
- sanitizes response text
- executes the resulting query through the main interpreter

Example:

```ts
import { NaturalLanguageExecutor } from './src/query-language/src/interpreter/nl.mts';
import { InMemoryStorageAdapter } from './src/storage-adapter/in-memory-storage-adapter.mts';

const adapter = new InMemoryStorageAdapter({
  USERS: [
    { ID: 1, NAME: 'Alice', ACTIVE: 1 },
    { ID: 2, NAME: 'Bob', ACTIVE: 0 },
  ],
});

const executor = new NaturalLanguageExecutor({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-5.4-mini',
  storageAdapter: adapter,
});

const result = await executor.executeNaturalLanguageQuery('Show active users');
console.log(result.rows);
```

## Testing

Run all tests:

```bash
npm test
```

Run coverage:

```bash
npm run test:coverage
```

Targeted suites:

- Parser: [tests/query-language/parser.spec.mts](tests/query-language/parser.spec.mts)
- Lexer: [tests/query-language/lexer.spec.mts](tests/query-language/lexer.spec.mts)
- Interpreter: [tests/query-language/interpreter.spec.mts](tests/query-language/interpreter.spec.mts)
- NL interpreter: [tests/query-language/interpreter/nl.spec.mts](tests/query-language/interpreter/nl.spec.mts)
- Executors: [tests/query-language/executors/select-executor.spec.mts](tests/query-language/executors/select-executor.spec.mts)
- Storage adapter: [tests/storage-adapter/in-memory-storage-adapter.spec.mts](tests/storage-adapter/in-memory-storage-adapter.spec.mts)

## Extending The Project

Recommended extension order:

1. Add or update token definitions in [src/query-language/types/tokens.mts](src/query-language/types/tokens.mts)
2. Extend parsing logic in [src/query-language/src/parser/parser.mts](src/query-language/src/parser/parser.mts) and supporting parser modules
3. Add AST shape updates in [src/query-language/types/ast-nodes.mts](src/query-language/types/ast-nodes.mts) and [src/query-language/types/ast-operations.mts](src/query-language/types/ast-operations.mts)
4. Implement execution behavior in the relevant executor
5. Add tests first-class in the matching test suite

Grammar sync checklist:

- If parser or token grammar behavior changes, update [GRAMMAR.ebnf](GRAMMAR.ebnf) in the same PR.
- Keep [AI_QUERY_LANGUAGE_SPEC.md](AI_QUERY_LANGUAGE_SPEC.md) aligned with the formal grammar constraints.

## Limitations

- Not a full SQL engine
- No transaction management
- No query planner cost model yet
- GROUP BY and HAVING are not fully executed as grouped aggregations yet

## Scripts

Project scripts from [package.json](package.json):

- npm test
- npm run test:coverage

## License

ISC

## Repository

- Homepage: https://github.com/tijngommers/querylib#readme
- Issues: https://github.com/tijngommers/querylib/issues
