//@author Tijn Gommers
//@date 2026-04-02

import type { InsertStatement, ValueNode } from '../types/index.mjs';
import type { InsertResult } from '../types/execution-results.mjs';
import type { StorageAdapter } from '../../storage-adapter/storage-adapter.mjs';
import type { StorageRow, StorageValue } from '../../storage-adapter/storage-adapter-types.mjs';

/**
 * Executes INSERT statements and materializes inserted rows.
 * @class InsertExecutor
 */
export class InsertExecutor {
  private storageAdapter?: StorageAdapter;

  /**
   * Creates an insert executor.
   * @param storageAdapter Optional storage adapter used for persistent writes.
   */
  constructor(storageAdapter?: StorageAdapter) {
    this.storageAdapter = storageAdapter;
  }

  /**
   * Executes an INSERT statement against in-memory rows or the configured storage adapter.
   * @param node Parsed INSERT statement AST node.
   * @param inputRows Mutable in-memory row collection used when no adapter is provided.
   * @returns {InsertResult | Promise<InsertResult>} Insert result object or a Promise that resolves to it when using a storage adapter.
   * @throws {Error} When INSERT statement validation fails.
   */
  executeInsert(
    node: InsertStatement,
    inputRows: StorageRow[] = [],
    ids: string[] = [],
    userId: string = 'NO_USER',
  ): InsertResult | Promise<InsertResult> {
    this.validateInsert(node);

    const insertedRows = this.buildInsertedRows(node);

    if (!this.storageAdapter || inputRows.length > 0) {
      inputRows.push(...insertedRows);

      return {
        type: 'InsertResult',
        table: node.table,
        columns: node.columns,
        values: node.values,
        insertedCount: insertedRows.length,
        rows: insertedRows,
      };
    }

    return (async () => {
      await this.storageAdapter!.write(node.table.name, insertedRows, ids, userId);

      return {
        type: 'InsertResult',
        table: node.table,
        columns: node.columns,
        values: node.values,
        insertedCount: insertedRows.length,
        rows: insertedRows,
      };
    })();
  }

  amountOfRows(node: InsertStatement) {
    this.validateInsert(node);
    const insertedRows = this.buildInsertedRows(node);
    return insertedRows.length;
  }

  /**
   * Validates INSERT table, columns, and values cardinality.
   * @param node Parsed INSERT statement AST node.
   * @returns {void}
   * @throws {Error} When required INSERT parts are missing or tuple lengths mismatch.
   */
  private validateInsert(node: InsertStatement): void {
    if (!node.table) {
      throw new Error('Invalid INSERT: no table specified');
    }

    if (!node.columns || node.columns.length === 0) {
      throw new Error('Invalid INSERT: no columns specified');
    }

    if (!node.values || node.values.length === 0) {
      throw new Error('Invalid INSERT: no values specified');
    }

    node.values.forEach((tuple) => {
      if (tuple.length !== node.columns.length) {
        throw new Error(
          `Invalid INSERT: column count ${node.columns.length} does not match values count ${tuple.length}`,
        );
      }
    });
  }

  /**
   * Materializes row objects from INSERT value tuples.
   * @param node Parsed INSERT statement AST node.
   * @returns {StorageRow[]} Array of row objects ready for insertion.
   */
  private buildInsertedRows(node: InsertStatement): StorageRow[] {
    return node.values.map((tuple) => {
      const row: StorageRow = {};

      node.columns.forEach((column, index) => {
        row[column.name] = this.resolveValueNode(tuple[index]);
      });

      return row;
    });
  }

  /**
   * Resolves a value node into a primitive value.
   * @param value Value node from INSERT tuples.
   * @returns {StorageValue} Primitive literal value or identifier name.
   */
  private resolveValueNode(value: ValueNode): StorageValue {
    if (value.type === 'Literal') {
      return value.value;
    }

    return value.name;
  }
}
