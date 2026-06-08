// @author Tijn Gommers
// @date 2026-03-31

import type { ExpressionNode, FromNode, IdentifierNode, SelectColumn, TableNode, ValueNode } from './ast-nodes.mjs';

/**
 * ORDER BY clause representation.
 * @interface OrderByItem
 * @property {IdentifierNode} column Ordered column.
 * @property {'ASC' | 'DESC'} [direction] Sort direction for this column, ascending by default.
 */
export interface OrderByItem {
  column: IdentifierNode;
  direction?: 'ASC' | 'DESC';
}

/**
 * ORDER BY clause representation.
 * @interface OrderByStatement
 * @property {'OrderByStatement'} type Discriminator for order-by nodes.
 * @property {OrderByItem[]} items Ordered columns and their directions.
 */
export interface OrderByStatement {
  type: 'OrderByStatement';
  items: OrderByItem[];
}

/**
 * LIMIT/OFFSET clause representation.
 * @interface LimitOffsetNode
 * @property {'LimitOffset'} type Discriminator for limit-offset nodes.
 * @property {number} limit Maximum row count.
 * @property {number} [offset] Row offset.
 */
export interface LimitOffsetNode {
  type: 'LimitOffset';
  limit: number;
  offset?: number;
}

/**
 * SELECT statement AST node.
 * @interface SelectStatement
 * @property {'SelectStatement'} type Statement discriminator.
 * @property {boolean} distinct Whether DISTINCT is enabled.
 * @property {SelectColumn[]} columns Selected columns.
 * @property {IdentifierNode[]} [groupBy] GROUP BY columns.
 * @property {FromNode[]} from FROM sources.
 * @property {ExpressionNode} [where] WHERE predicate.
 * @property {ExpressionNode} [having] HAVING predicate.
 * @property {OrderByStatement} [orderBy] ORDER BY clause.
 * @property {LimitOffsetNode} [limit] LIMIT/OFFSET clause.
 */
export interface SelectStatement {
  type: 'SelectStatement';
  distinct: boolean;
  columns: SelectColumn[];
  groupBy?: IdentifierNode[];
  from: FromNode[];
  where?: ExpressionNode;
  having?: ExpressionNode;
  orderBy?: OrderByStatement;
  limit?: LimitOffsetNode;
}

/**
 * DELETE statement AST node.
 * @interface DeleteStatement
 * @property {'DeleteStatement'} type Statement discriminator.
 * @property {TableNode[]} from Target tables.
 * @property {ExpressionNode} [where] Optional delete predicate.
 */
export interface DeleteStatement {
  type: 'DeleteStatement';
  from: TableNode[];
  where?: ExpressionNode;
}

/**
 * INSERT statement AST node.
 * @interface InsertStatement
 * @property {'InsertStatement'} type Statement discriminator.
 * @property {TableNode} table Target table.
 * @property {IdentifierNode[]} columns Insert columns.
 * @property {ValueNode[][]} values Inserted value tuples.
 */
export interface InsertStatement {
  type: 'InsertStatement';
  table: TableNode;
  columns: IdentifierNode[];
  values: ValueNode[][];
}

/**
 * UPDATE statement AST node.
 * @interface UpdateStatement
 * @property {'UpdateStatement'} type Statement discriminator.
 * @property {TableNode} table Target table.
 * @property {{ column: IdentifierNode; value: ValueNode }[]} set SET assignments.
 * @property {ExpressionNode} [where] Optional update predicate.
 */
export interface UpdateStatement {
  type: 'UpdateStatement';
  table: TableNode;
  set: { column: IdentifierNode; value: ValueNode }[];
  where?: ExpressionNode;
}

/**
 * Root AST statement union.
 * @typedef {SelectStatement | DeleteStatement | InsertStatement | UpdateStatement} ASTNode
 */
export type ASTNode = SelectStatement | DeleteStatement | InsertStatement | UpdateStatement;
