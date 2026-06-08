//@author Tijn Gommers
//@date 2026-04-02

import type { DeleteStatement, ExpressionNode } from '../types/index.mjs';
import type { DeleteResult } from '../types/execution-results.mjs';
import type { StorageAdapter } from '../../storage-adapter/storage-adapter.mjs';
import { compileStorageWherePredicate, getSingleTableName } from './storage-adapter-helpers.mjs';

/**
 * Executes DELETE statements with optional storage-adapter support.
 * @class DeleteExecutor
 */
export class DeleteExecutor {
  private storageAdapter?: StorageAdapter;

  /**
   * Creates a delete executor.
   * @param storageAdapter Optional storage adapter used for persistence operations.
   */
  constructor(storageAdapter?: StorageAdapter) {
    this.storageAdapter = storageAdapter;
  }

  /**
   * Executes a DELETE statement and returns metadata about the deletion.
   * @param node Parsed DELETE statement AST node.
   * @returns {DeleteResult | Promise<DeleteResult>} Delete result object or a Promise that resolves to it when using a storage adapter.
   * @throws {Error} When the DELETE statement is invalid.
   */
  executeDelete(node: DeleteStatement): DeleteResult | Promise<DeleteResult> {
    this.validateDelete(node);

    const from = node.from;
    const where = this.normalizeWhereExpression(node.where);
    const tableName = getSingleTableName(node.from);

    if (!this.storageAdapter || !tableName) {
      return {
        type: 'DeleteResult',
        from,
        where,
      };
    }

    return (async () => {
      const predicate = compileStorageWherePredicate(where);
      const matchingRows = predicate
        ? await this.storageAdapter!.filter(tableName, predicate)
        : await this.storageAdapter!.read(tableName, ['*']);

      await this.storageAdapter!.delete(tableName, predicate);

      return {
        type: 'DeleteResult',
        from,
        where,
        deletedCount: matchingRows.length,
      };
    })();
  }

  /**
   * Normalizes nested WHERE-expression nodes.
   * @param where Optional expression from a DELETE statement.
   * @returns {ExpressionNode | undefined} Normalized expression or undefined when no WHERE exists.
   */
  private normalizeWhereExpression(where?: ExpressionNode): ExpressionNode | undefined {
    if (!where) {
      return undefined;
    }

    if (where.type === 'LogicalExpression') {
      return {
        ...where,
        left: this.normalizeWhereExpression(where.left) as ExpressionNode,
        right: this.normalizeWhereExpression(where.right) as ExpressionNode,
      };
    }

    if (where.type === 'NotExpression') {
      return {
        ...where,
        expression: this.normalizeWhereExpression(where.expression) as ExpressionNode,
      };
    }

    return where;
  }

  /**
   * Validates minimal DELETE statement requirements.
   * @param node Parsed DELETE statement AST node.
   * @returns {void}
   * @throws {Error} When no FROM clause is present.
   */
  private validateDelete(node: DeleteStatement): void {
    if (!node.from || node.from.length === 0) {
      throw new Error('Invalid DELETE: no FROM clause');
    }
  }

  /**
   * Indicates whether a DELETE contains a WHERE clause.
   * @param node Parsed DELETE statement AST node.
   * @returns {boolean} True when a WHERE clause exists.
   */
  isSafeDelete(node: DeleteStatement): boolean {
    return node.where !== undefined;
  }
}
