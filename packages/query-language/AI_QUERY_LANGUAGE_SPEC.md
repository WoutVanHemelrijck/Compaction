# Querylib AI Query Language Spec

Purpose: this file is for AI systems that need to generate valid queries for this project.

Formal grammar source: [GRAMMAR.ebnf](GRAMMAR.ebnf)

This document is a practical guide for generation and migration. When there is a conflict,
the formal grammar in [GRAMMAR.ebnf](GRAMMAR.ebnf) is the source of truth.

## Core Rules

- Generate exactly one statement per request.
- Do not include a trailing semicolon.
- Output only raw query text (no markdown, no explanation).
- Use only supported statements: `SELECT`, `INSERT`, `UPDATE`, `DELETE`.
- Keywords are case-insensitive in practice (lexer uppercases identifiers), but use uppercase keywords for consistency.

## Statement Grammar (Current)

### SELECT

Pattern:

`SELECT [DISTINCT] <columns> FROM <sources> [WHERE <expr>] [GROUP BY <columns>] [HAVING <expr>] [ORDER BY <columns>] [LIMIT <n> [OFFSET <n>]]`

Details:

- `<columns>`: `*`, identifiers, or aggregate functions.
- Aggregates supported: `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`.
- Only `COUNT(*)` supports wildcard argument.
- `HAVING` requires `GROUP BY`.

### DELETE

Pattern:

`DELETE FROM <table_list> [WHERE <expr>]`

Details:

- `JOIN` is not allowed in `DELETE`.

### INSERT

Pattern:

`INSERT INTO <table> (<columns>) VALUES (<tuple>) [, (<tuple>), ...]`

Details:

- At least one tuple is required.
- Tuple length must match column count.

### UPDATE

Pattern:

`UPDATE <table> SET <column>=<value> [, <column>=<value>, ...] [WHERE <expr>]`

## Expressions

Supported operators:

- Logical: `AND`, `OR`, `NOT`
- Comparison: `=`, `!=`, `>`, `>=`, `<`, `<=`
- Null checks: `IS NULL`, `IS NOT NULL`
- Set membership: `IN (...)`
- Arithmetic in comparisons: `+`, `-`, `*`, `/`

Precedence:

1. Parentheses
2. Unary `NOT`
3. Arithmetic `*`, `/`
4. Arithmetic `+`, `-`
5. Comparisons (`=`, `!=`, `>`, `>=`, `<`, `<=`, `IN`, `IS NULL`)
6. `AND`
7. `OR`

## Values and Identifiers

- Numbers: integer tokens (no decimal literal support in lexer).
- Strings: single-quoted, for example `'Alice'`.
- Null literal: `NULL`.
- Identifiers: letters, digits, underscore; dot notation is supported (`USERS.ID`).

## Joins and Sources

Supported source forms in `SELECT FROM`:

- Comma-separated tables: `FROM USERS, ORDERS`
- `CROSS JOIN`
- `JOIN` (interpreted as inner join)
- `INNER JOIN`, `LEFT JOIN`, `RIGHT JOIN`, optional `OUTER` keyword

Join condition rules:

- `CROSS JOIN <table>` does not use an `ON` clause.
- Qualified joins (`JOIN`, `INNER JOIN`, `LEFT JOIN`, `RIGHT JOIN`, `OUTER JOIN`) require:
  `... JOIN <table> ON <left> <comparison_op> <right>`

## Important Runtime Limitations

- This is SQL-like, not full SQL.
- Grouped aggregate execution is not fully implemented yet.
- JOIN parsing exists; execution behavior is limited compared to full SQL engines.
- Use simple, explicit queries to maximize correctness.

## Current Parser Constraints (Ambiguity Guards)

- `JOIN ... ON` currently accepts one comparison form: `<identifier> <comparison_op> <value_expression>`.
- `DELETE` does not support join sources.
- Aggregate wildcard support is limited to `COUNT(*)`.
- Decimal numeric literals are not supported by the lexer.
- Identifiers are normalized to uppercase in parser output.

## AI Output Constraints

When generating a query:

- Return one valid statement only.
- Never return multiple statements.
- Never wrap in code fences.
- Avoid unsupported SQL features (subqueries, aliases, `BETWEEN`, `LIKE`, `UNION`, `CREATE`, `DROP`, `ALTER`).

## Dutch Keyword Migration Contract

When migrating from SQL keywords to Dutch keywords, keep these semantic slots stable.
Only surface tokens should change; structure should remain equivalent.

Current semantic keyword set:

- `SELECT`, `DISTINCT`, `FROM`, `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `ASC`, `DESC`, `LIMIT`, `OFFSET`
- `INSERT`, `INTO`, `VALUES`
- `UPDATE`, `SET`
- `DELETE`
- `JOIN`, `INNER`, `LEFT`, `RIGHT`, `OUTER`, `CROSS`, `ON`
- `AND`, `OR`, `NOT`, `IN`, `IS`, `NULL`

Suggested migration process:

1. Define a one-to-one Dutch replacement map for all keywords above.
2. Keep operators and punctuation unchanged unless parser/lexer is updated for alternatives.
3. Keep clause order exactly the same as current grammar.
4. Update this file with the final mapping table.

Template mapping table (fill during migration):

| Semantic role | Current keyword | Dutch keyword |
| ------------- | --------------- | ------------- |
| select        | SELECT          | TODO          |
| from          | FROM            | TODO          |
| where         | WHERE           | TODO          |
| and           | AND             | TODO          |
| or            | OR              | TODO          |
| not           | NOT             | TODO          |
| insert        | INSERT          | TODO          |
| into          | INTO            | TODO          |
| values        | VALUES          | TODO          |
| update        | UPDATE          | TODO          |
| set           | SET             | TODO          |
| delete        | DELETE          | TODO          |

## Canonical Examples

SELECT example:

`SELECT DISTINCT NAME FROM USERS WHERE ACTIVE = 1 ORDER BY NAME ASC LIMIT 10`

INSERT example:

`INSERT INTO USERS (ID, NAME, ACTIVE) VALUES (1, 'Alice', 1), (2, 'Bob', 0)`

UPDATE example:

`UPDATE USERS SET ACTIVE = 1 WHERE ID = 2`

DELETE example:

`DELETE FROM USERS WHERE ACTIVE = 0`
