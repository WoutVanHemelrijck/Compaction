// @author Tijn Gommers
// @date 2026-03-31

/**
 * Table reference in a FROM clause.
 * @interface TableNode
 * @property {'Table'} type Discriminator for table nodes.
 * @property {string} name Table name.
 */
export interface TableNode {
  type: 'Table';
  name: string;
}

/**
 * Identifier reference, optionally dotted (for example table.column).
 * @interface IdentifierNode
 * @property {'Identifier'} type Discriminator for identifier nodes.
 * @property {string} name Identifier text.
 */
export interface IdentifierNode {
  type: 'Identifier';
  name: string;
}

/**
 * Literal value used in expressions.
 * @interface LiteralNode
 * @property {'Literal'} type Discriminator for literal nodes.
 * @property {'number' | 'string' | 'null'} valueType Literal category.
 * @property {string | number | null} value Literal payload.
 */
export interface LiteralNode {
  type: 'Literal';
  valueType: 'number' | 'string' | 'null';
  value: string | number | null;
}

/**
 * Wildcard token (*) used in SELECT and aggregate arguments.
 * @interface WildcardNode
 * @property {'Wildcard'} type Discriminator for wildcard nodes.
 * @property {'*'} value Wildcard symbol.
 */
export interface WildcardNode {
  type: 'Wildcard';
  value: '*';
}

/**
 * Supported comparison operators.
 * @typedef {'=' | '>' | '<' | '>=' | '<=' | '!='} ComparisonOperator
 */
export type ComparisonOperator = '=' | '>' | '<' | '>=' | '<=' | '!=';

/**
 * Supported arithmetic operators.
 * @typedef {'+' | '-' | '*' | '/'} ArithmeticOperator
 */
export type ArithmeticOperator = '+' | '-' | '*' | '/';

/**
 * Supported aggregate function names.
 * @typedef {'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX'} AggregateFunctionName
 */
export type AggregateFunctionName = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';

/**
 * Aggregate function expression node.
 * @interface AggregateFunctionNode
 * @property {'AggregateFunction'} type Discriminator for aggregate functions.
 * @property {AggregateFunctionName} functionName Aggregate function name.
 * @property {IdentifierNode | WildcardNode} argument Function argument.
 */
export interface AggregateFunctionNode {
  type: 'AggregateFunction';
  functionName: AggregateFunctionName;
  argument: IdentifierNode | WildcardNode;
}

/**
 * Column expression allowed in SELECT lists.
 * @typedef {IdentifierNode | AggregateFunctionNode} SelectColumn
 */
export type SelectColumn = IdentifierNode | AggregateFunctionNode;

/**
 * Arithmetic expression node.
 * @interface ArithmeticExpressionNode
 * @property {'ArithmeticExpression'} type Discriminator for arithmetic expressions.
 * @property {ValueExpressionNode} left Left operand.
 * @property {ArithmeticOperator} operator Arithmetic operator.
 * @property {ValueExpressionNode} right Right operand.
 */
export interface ArithmeticExpressionNode {
  type: 'ArithmeticExpression';
  left: ValueExpressionNode;
  operator: ArithmeticOperator;
  right: ValueExpressionNode;
}

/**
 * Expression types that can appear as values in comparisons and arithmetic expressions.
 * @typedef {IdentifierNode | LiteralNode | ArithmeticExpressionNode | AggregateFunctionNode} ValueExpressionNode
 */
export type ValueExpressionNode = IdentifierNode | LiteralNode | ArithmeticExpressionNode | AggregateFunctionNode;

/**
 * Value types allowed in insert/update and IN lists.
 * @typedef {IdentifierNode | LiteralNode} ValueNode
 */
export type ValueNode = IdentifierNode | LiteralNode;

/**
 * Comparison expression node.
 * @interface ComparisonNode
 * @property {'ComparisonExpression'} type Discriminator for comparisons.
 * @property {ValueExpressionNode} left Left operand.
 * @property {ComparisonOperator} operator Comparison operator.
 * @property {ValueExpressionNode} right Right operand.
 */
export interface ComparisonNode {
  type: 'ComparisonExpression';
  left: ValueExpressionNode;
  operator: ComparisonOperator;
  right: ValueExpressionNode;
}

/**
 * Logical expression node.
 * @interface LogicalNode
 * @property {'LogicalExpression'} type Discriminator for logical expressions.
 * @property {'AND' | 'OR' | 'NOT'} operator Logical operator.
 * @property {ExpressionNode} left Left operand.
 * @property {ExpressionNode} right Right operand.
 */
export interface LogicalNode {
  type: 'LogicalExpression';
  operator: 'AND' | 'OR' | 'NOT';
  left: ExpressionNode;
  right: ExpressionNode;
}

/**
 * Unary NOT expression node.
 * @interface NotExpressionNode
 * @property {'NotExpression'} type Discriminator for unary NOT expressions.
 * @property {'NOT'} operator Unary operator.
 * @property {ExpressionNode} expression Inner expression.
 */
export interface NotExpressionNode {
  type: 'NotExpression';
  operator: 'NOT';
  expression: ExpressionNode;
}

/**
 * IS NULL / IS NOT NULL expression node.
 * @interface NullCheckExpressionNode
 * @property {'NullCheckExpression'} type Discriminator for null checks.
 * @property {IdentifierNode} left Identifier being checked.
 * @property {boolean} isNegated Whether the check is IS NOT NULL.
 */
export interface NullCheckExpressionNode {
  type: 'NullCheckExpression';
  left: IdentifierNode;
  isNegated: boolean;
}

/**
 * IN (...) expression node.
 * @interface InExpressionNode
 * @property {'InExpression'} type Discriminator for IN expressions.
 * @property {IdentifierNode} left Identifier being tested.
 * @property {ValueNode[]} values IN-list values.
 */
export interface InExpressionNode {
  type: 'InExpression';
  left: IdentifierNode;
  values: ValueNode[];
}

/**
 * Expression types supported by WHERE and HAVING clauses.
 * @typedef {ComparisonNode | LogicalNode | NotExpressionNode | NullCheckExpressionNode | InExpressionNode} ExpressionNode
 */
export type ExpressionNode =
  | ComparisonNode
  | LogicalNode
  | NotExpressionNode
  | NullCheckExpressionNode
  | InExpressionNode;

/**
 * Join source node in a FROM clause.
 * @interface JoinNode
 * @property {'Join'} type Discriminator for join nodes.
 * @property {TableNode} table Joined table.
 * @property {'CROSS' | 'INNER' | 'LEFT' | 'RIGHT' | 'OUTER'} joinType Join kind.
 * @property {ComparisonNode} [on] Join predicate (required for non-CROSS joins).
 */
export interface JoinNode {
  type: 'Join';
  table: TableNode;
  joinType: 'CROSS' | 'INNER' | 'LEFT' | 'RIGHT' | 'OUTER';
  on?: ComparisonNode;
}

/**
 * Source node types allowed in FROM clauses.
 * @typedef {TableNode | JoinNode} FromNode
 */
export type FromNode = TableNode | JoinNode;
