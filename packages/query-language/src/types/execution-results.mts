// @author Tijn Gommers
// @date 2026-04-03

import type {
  DeleteStatement,
  InsertStatement,
  LimitOffsetNode,
  OrderByStatement,
  UpdateStatement,
} from './ast-operations.mjs';
import type { ExpressionNode, FromNode, JoinNode, SelectColumn } from './ast-nodes.mjs';

/**
 * Shared utility for synchronous or promise-backed execution results.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * SELECT execution result.
 * @interface SelectResult
 * @property {'SelectResult'} type Discriminator for select results.
 * @property {SelectColumn[]} columns Selected columns.
 * @property {boolean} distinct Whether DISTINCT is enabled.
 * @property {SelectFromItem[]} from Normalized FROM items.
 * @property {ExpressionNode} [where] WHERE predicate.
 * @property {OrderByStatement} [orderBy] ORDER BY clause.
 * @property {LimitOffsetNode} [limit] LIMIT/OFFSET clause.
 * @property {Record<string, unknown>[]} [rows] Result rows, if available.
 */
export interface SelectResult {
  type: 'SelectResult';
  columns: SelectColumn[];
  distinct: boolean;
  from: SelectFromItem[];
  where?: ExpressionNode;
  orderBy?: OrderByStatement;
  limit?: LimitOffsetNode;
  rows?: Record<string, unknown>[];
}

/**
 * Normalized FROM item returned from SELECT execution.
 * Can be a simple table reference or a JOIN structure, depending on the original AST.
 * This allows execution results to provide a consistent structure regardless of the original query complexity.
 * @typedef {FromNode | SelectJoinItem} SelectFromItem
 */
export interface SelectJoinItem {
  type: 'Join';
  table: JoinNode['table'];
  joinType: JoinNode['joinType'];
  on?: JoinNode['on'];
}

export type SelectFromItem = FromNode | SelectJoinItem;

/**
 * DELETE execution result.
 * @interface DeleteResult
 * @property {'DeleteResult'} type Discriminator for delete results.
 * @property {TableNode[]} from Deleted tables.
 * @property {ExpressionNode} [where] WHERE predicate used for deletion.
 * @property {number} [deletedCount] Number of rows deleted, if available.
 */
export interface DeleteResult {
  type: 'DeleteResult';
  from: DeleteStatement['from'];
  where?: ExpressionNode;
  deletedCount?: number;
}

/**
 * INSERT execution result.
 * @interface InsertResult
 * @property {'InsertResult'} type Discriminator for insert results.
 * @property {TableNode} table Target table.
 * @property {IdentifierNode[]} columns Insert columns.
 * @property {ValueNode[][]} values Inserted value tuples.
 * @property {number} insertedCount Number of rows inserted.
 * @property {Record<string, unknown>[]} rows Inserted rows, if available.
 */
export interface InsertResult {
  type: 'InsertResult';
  table: InsertStatement['table'];
  columns: InsertStatement['columns'];
  values: InsertStatement['values'];
  insertedCount: number;
  rows: Record<string, unknown>[];
}

/**
 * UPDATE execution result.
 * @interface UpdateResult
 * @property {'UpdateResult'} type Discriminator for update results.
 * @property {TableNode} table Target table.
 * @property {{ column: IdentifierNode; value: ValueNode }[]} set SET assignments.
 * @property {ExpressionNode} [where] WHERE predicate used for update.
 * @property {number} [updatedCount] Number of rows updated, if available.
 * @property {Record<string, unknown>[]} [rows] Updated rows, if available.
 */
export interface UpdateResult {
  type: 'UpdateResult';
  table: UpdateStatement['table'];
  set: UpdateStatement['set'];
  where?: ExpressionNode;
  updatedCount: number;
  rows: Record<string, unknown>[];
}

/**
 * Root execution result union.
 * @typedef {SelectResult | DeleteResult | InsertResult | UpdateResult} QueryExecutionResult
 */
export type QueryExecutionResult = SelectResult | DeleteResult | InsertResult | UpdateResult;
