//@author Tijn Gommers
//@date 2026-04-02

import type { StorageAdapter } from './storage-adapter.mjs';
import type {
  StorageIdentifierReference,
  StorageOperand,
  StoragePredicate,
  StorageRow,
  StorageSetPayload,
  StorageValue,
} from './storage-adapter-types.mjs';

type Row = StorageRow;
type TableStore = Map<string, Row[]>;

/**
 * In-memory implementation of the StorageAdapter contract for testing and local execution.
 * @class InMemoryStorageAdapter
 */
export class InMemoryStorageAdapter implements StorageAdapter {
  private tables: TableStore;

  /**
   * Creates an in-memory adapter initialized with optional seed data.
   * @param {Record<string, Row[]>} [initialData={}] Seed rows keyed by table name.
   */
  constructor(initialData: Record<string, Row[]> = {}) {
    this.tables = new Map<string, Row[]>();

    Object.entries(initialData).forEach(([tableName, rows]) => {
      this.tables.set(
        tableName,
        rows.map((row) => this.cloneRow(row)),
      );
    });
  }

  /**
   * Reads rows from a table and optionally applies predicate and projection.
   * @param {string} table Target table name.
   * @param {string[]} columns Projected columns or wildcard projection.
   * @param {Record<string, any>} [where] Optional predicate.
   * @returns {Promise<Row[]>} Matching rows.
   * @throws {Error} When the table does not exist.
   */
  read(table: string, columns: string[], where?: StoragePredicate): Promise<Row[]> {
    return Promise.resolve().then(() => {
      const rows = this.getTableRows(table, true);
      const filteredRows = this.applyPredicate(rows, where);

      if (columns.length === 0 || columns.includes('*')) {
        return filteredRows.map((row) => this.cloneRow(row));
      }

      return filteredRows.map((row) => {
        const projected: Row = {};

        columns.forEach((column) => {
          projected[column] = this.resolveIdentifierValue(row, column) ?? null;
        });

        return projected;
      });
    });
  }

  /**
   * Appends rows to a table.
   * @param {string} table Target table name.
   * @param {Row[]} rows Rows to append.
   * @returns {Promise<void>} Resolves when rows are written.
   */
  write(table: string, rows: Row[]): Promise<void> {
    const existingRows = this.getTableRows(table, false);
    rows.forEach((row) => existingRows.push(this.cloneRow(row)));
    return Promise.resolve();
  }

  /**
   * Filters rows in a table using a predicate.
   * @param {string} table Target table name.
   * @param {Record<string, any>} where Predicate object.
   * @returns {Promise<Row[]>} Filtered rows.
   * @throws {Error} When the table does not exist.
   */
  filter(table: string, where: StoragePredicate): Promise<Row[]> {
    return Promise.resolve().then(() => {
      const rows = this.getTableRows(table, true);
      return this.applyPredicate(rows, where).map((row) => this.cloneRow(row));
    });
  }

  /**
   * Projects only selected columns from all rows in a table.
   * @param {string} table Target table name.
   * @param {string[]} columns Columns to project.
   * @returns {Promise<Row[]>} Projected rows.
   * @throws {Error} When the table does not exist.
   */
  project(table: string, columns: string[]): Promise<Row[]> {
    return this.read(table, columns);
  }

  /**
   * Deletes rows matching a predicate.
   * @param {string} table Target table name.
   * @param {StoragePredicate} [where] Optional predicate object. When omitted, all rows are deleted.
   * @returns {Promise<void>} Resolves when deletion completes.
   * @throws {Error} When the table does not exist.
   */
  delete(table: string, where?: StoragePredicate): Promise<void> {
    const rows = this.getTableRows(table, true);

    if (this.isEmptyPredicate(where)) {
      this.tables.set(table, []);
      return Promise.resolve();
    }

    const remainingRows = rows.filter((row) => !this.evaluatePredicate(where, row));
    this.tables.set(table, remainingRows);
    return Promise.resolve();
  }

  /**
   * Updates rows matching a predicate with values from a set payload.
   * @param {string} table Target table name.
   * @param {Record<string, any>} set Partial row payload to apply.
   * @param {Record<string, any>} [where] Optional predicate object. When omitted, all rows are updated.
   * @returns {Promise<void>} Resolves when updates complete.
   * @throws {Error} When the table does not exist.
   */
  update(table: string, set: StorageSetPayload, where?: StoragePredicate): Promise<void> {
    const rows = this.getTableRows(table, true);

    rows.forEach((row) => {
      if (where && !this.isEmptyPredicate(where) && !this.evaluatePredicate(where, row)) {
        return;
      }

      Object.entries(set).forEach(([column, value]) => {
        row[column] = this.resolveSetValue(value, row);
      });
    });

    return Promise.resolve();
  }

  /**
   * Returns a deep-cloned snapshot of all tables.
   * @returns {Record<string, Row[]>} Snapshot keyed by table name.
   */
  getSnapshot(): Record<string, Row[]> {
    const snapshot: Record<string, Row[]> = {};

    this.tables.forEach((rows, tableName) => {
      snapshot[tableName] = rows.map((row) => this.cloneRow(row));
    });

    return snapshot;
  }

  /**
   * Applies a predicate to an array of rows.
   * @param {Row[]} rows Candidate rows.
   * @param {Record<string, any>} [where] Optional predicate.
   * @returns {Row[]} Filtered row list.
   */
  private applyPredicate(rows: Row[], where?: StoragePredicate): Row[] {
    if (!where || this.isEmptyPredicate(where)) {
      return rows;
    }

    return rows.filter((row) => this.evaluatePredicate(where, row));
  }

  /**
   * Evaluates a storage predicate against one row.
   * @param {Record<string, any>} predicate Predicate object.
   * @param {Row} row Row under evaluation.
   * @returns {boolean} True when row matches predicate.
   */
  private evaluatePredicate(predicate: StoragePredicate | undefined, row: Row): boolean {
    if (!predicate) {
      return false;
    }

    switch (predicate.type) {
      case 'LogicalExpression':
        if (predicate.operator === 'AND') {
          return this.evaluatePredicate(predicate.left, row) && this.evaluatePredicate(predicate.right, row);
        }
        return this.evaluatePredicate(predicate.left, row) || this.evaluatePredicate(predicate.right, row);
      case 'NotExpression':
        return !this.evaluatePredicate(predicate.expression, row);
      case 'ComparisonExpression': {
        const left = this.resolveOperand(predicate.left, row);
        const right = this.resolveOperand(predicate.right, row);
        return this.compareValues(left, right, predicate.operator);
      }
      case 'NullCheckExpression': {
        const value = this.resolveIdentifierValue(row, String(predicate.column));
        const isNullish = value === null || value === undefined;
        return predicate.isNegated ? !isNullish : isNullish;
      }
      case 'InExpression': {
        const left = this.resolveIdentifierValue(row, String(predicate.column));
        return (
          Array.isArray(predicate.values) && predicate.values.some((value) => this.resolveOperand(value, row) === left)
        );
      }
      default:
        return false;
    }
  }

  /**
   * Resolves an operand into a primitive value for predicate evaluation.
   * @param {unknown} operand Predicate operand.
   * @param {Row} row Current row.
   * @returns {unknown} Resolved operand value.
   * @throws {Error} When arithmetic operands are invalid.
   */
  private resolveOperand(operand: unknown, row: Row): unknown {
    if (operand === null || operand === undefined || typeof operand === 'number') {
      return operand;
    }

    if (typeof operand === 'string') {
      const resolved = this.resolveIdentifierValue(row, operand);
      return resolved === undefined ? operand : resolved;
    }

    if (typeof operand !== 'object') {
      return operand;
    }

    if (this.isRecord(operand) && operand['type'] === 'Literal' && 'value' in operand) {
      return operand['value'];
    }

    if (this.isRecord(operand) && operand['type'] === 'Identifier' && typeof operand['name'] === 'string') {
      return this.resolveIdentifierValue(row, operand['name']);
    }

    if (this.isArithmeticOperand(operand)) {
      const left = this.resolveOperand(operand.left, row);
      const right = this.resolveOperand(operand.right, row);
      return this.applyArithmetic(left, right, operand.operator);
    }

    if (this.isIdentifierReference(operand)) {
      return this.resolveIdentifierValue(row, operand.name);
    }

    return operand;
  }

  /**
   * Resolves a SET payload value for update operations.
   * @param {unknown} value Raw set value.
   * @param {Row} row Current row context.
   * @returns {StorageValue} Resolved set value.
   */
  private resolveSetValue(value: unknown, row: Row): StorageValue {
    if (this.isIdentifierReference(value)) {
      return this.resolveIdentifierValue(row, value.name) ?? null;
    }

    return this.toStorageValue(value);
  }

  /**
   * Resolves an identifier path from a row, case-insensitively.
   * @param {Row} row Source row.
   * @param {string} identifier Identifier path.
   * @returns {StorageValue | undefined} Resolved value or undefined.
   */
  private resolveIdentifierValue(row: Row, identifier: string): StorageValue | undefined {
    const path = identifier.split('.');
    let current: unknown = row;

    for (const segment of path) {
      if (!this.isRecord(current)) {
        return undefined;
      }

      if (segment in current) {
        current = current[segment];
        continue;
      }

      const key = Object.keys(current).find((existingKey) => existingKey.toUpperCase() === segment.toUpperCase());
      if (!key) {
        return undefined;
      }

      current = current[key];
    }

    return this.isStorageValue(current) ? current : undefined;
  }

  /**
   * Compares two values using a comparison operator.
   * @param {unknown} left Left value.
   * @param {unknown} right Right value.
   * @param {string} operator Comparison operator.
   * @returns {boolean} Comparison result.
   */
  private compareValues(left: unknown, right: unknown, operator: string): boolean {
    const areBothNumbers = typeof left === 'number' && typeof right === 'number';
    const areBothStrings = typeof left === 'string' && typeof right === 'string';

    switch (operator) {
      case '=':
        return left === right;
      case '!=':
        return left !== right;
      case '>':
        return (areBothNumbers || areBothStrings) && left > right;
      case '<':
        return (areBothNumbers || areBothStrings) && left < right;
      case '>=':
        return (areBothNumbers || areBothStrings) && left >= right;
      case '<=':
        return (areBothNumbers || areBothStrings) && left <= right;
      default:
        return false;
    }
  }

  /**
   * Applies an arithmetic operation to numeric operands.
   * @param {unknown} left Left operand.
   * @param {unknown} right Right operand.
   * @param {string} operator Arithmetic operator.
   * @returns {number} Arithmetic result.
   * @throws {Error} When operands are non-numeric, division by zero is attempted, or operator is unsupported.
   */
  private applyArithmetic(left: unknown, right: unknown, operator: string): number {
    if (typeof left !== 'number' || typeof right !== 'number') {
      throw new Error(`Invalid arithmetic operands: ${String(left)} ${operator} ${String(right)}`);
    }

    switch (operator) {
      case '+':
        return left + right;
      case '-':
        return left - right;
      case '*':
        return left * right;
      case '/':
        if (right === 0) {
          throw new Error('Division by zero');
        }
        return left / right;
      default:
        throw new Error(`Unsupported arithmetic operator: ${operator}`);
    }
  }

  /**
   * Resolves table storage by name, optionally enforcing existence.
   * @param {string} table Requested table name.
   * @param {boolean} mustExist Whether missing table names should throw.
   * @returns {Row[]} Mutable table row array.
   * @throws {Error} When table is missing and mustExist is true.
   */
  private getTableRows(table: string, mustExist: boolean): Row[] {
    const resolvedTableName = this.findTableName(table);

    if (resolvedTableName) {
      return this.tables.get(resolvedTableName)!;
    }

    if (mustExist) {
      throw new Error(`Unknown table: ${table}`);
    }

    const rows: Row[] = [];
    this.tables.set(table, rows);
    return rows;
  }

  /**
   * Finds an existing table name using exact or case-insensitive matching.
   * @param {string} table Requested table name.
   * @returns {string | undefined} Matched table name, if found.
   */
  private findTableName(table: string): string | undefined {
    if (this.tables.has(table)) {
      return table;
    }

    const matched = Array.from(this.tables.keys()).find((existing) => existing.toUpperCase() === table.toUpperCase());
    return matched;
  }

  /**
   * Checks whether a predicate object is empty.
   * @param {Record<string, any>} [where] Predicate object.
   * @returns {boolean} True when predicate is absent or empty.
   */
  private isEmptyPredicate(where?: StoragePredicate): boolean {
    return !where || Object.keys(where).length === 0;
  }

  /**
   * Deep-clones a row using JSON serialization.
   * @param {Row} row Source row.
   * @returns {Row} Deep-cloned row.
   */
  private cloneRow(row: Row): Row {
    return this.toStorageValue(JSON.parse(JSON.stringify(row))) as Row;
  }

  /**
   * Checks whether a value is a non-null object with string keys.
   * @param value Candidate value to inspect.
   * @returns {value is Record<string, unknown>} True when value is a plain object-like record.
   */
  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  /**
   * Checks whether a value is an identifier reference payload used in expressions/set values.
   * @param value Candidate value to inspect.
   * @returns {value is IdentifierReference} True when value matches { type: 'Identifier', name: string }.
   */
  private isIdentifierReference(value: unknown): value is StorageIdentifierReference {
    return this.isRecord(value) && value['type'] === 'Identifier' && typeof value['name'] === 'string';
  }

  /**
   * Checks whether a value is an arithmetic storage operand.
   * @param value Candidate value to inspect.
   * @returns {value is Extract<StorageOperand, { type: 'ArithmeticExpression' }>} True when operand is an arithmetic expression object.
   */
  private isArithmeticOperand(value: unknown): value is Extract<StorageOperand, { type: 'ArithmeticExpression' }> {
    return this.isRecord(value) && value['type'] === 'ArithmeticExpression';
  }

  /**
   * Validates whether a runtime value is compatible with StorageValue.
   * @param value Candidate value to validate.
   * @returns {value is StorageValue} True when value can be stored in adapter rows.
   */
  private isStorageValue(value: unknown): value is StorageValue {
    if (value === null) {
      return true;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return true;
    }

    if (Array.isArray(value)) {
      return value.every((item) => this.isStorageValue(item));
    }

    if (this.isRecord(value)) {
      return Object.values(value).every((item) => this.isStorageValue(item));
    }

    return false;
  }

  /**
   * Converts arbitrary runtime input into a StorageValue-safe representation.
   * Unsupported primitives are coerced to null.
   * @param value Runtime value to normalize.
   * @returns {StorageValue} Normalized storage-safe value.
   */
  private toStorageValue(value: unknown): StorageValue {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.toStorageValue(item));
    }

    if (this.isRecord(value)) {
      const normalized: StorageRow = {};
      Object.entries(value).forEach(([key, val]) => {
        normalized[key] = this.toStorageValue(val);
      });
      return normalized;
    }

    return null;
  }
}
