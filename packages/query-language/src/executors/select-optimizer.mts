//@author Tijn Gommers
//@date 2026-04-02

import type {
  ExpressionNode,
  FromNode,
  IdentifierNode,
  JoinNode,
  SelectColumn,
  SelectStatement,
  ValueExpressionNode,
} from '../types/index.mjs';

/**
 * Defines the structure of the result returned by the SelectOptimizer after optimizing a SELECT statement, including cascaded and ordered selections, pushed selections by table, residual selections, projection information, introduced joins, and the optimized FROM clause. This interface is used to encapsulate all relevant information produced during the optimization process that can be utilized by the SelectExecutor for efficient query execution.
 * @interface SelectOptimizationResult
 * @property {ExpressionNode[]} cascadedSelections - An array of selection expressions that have been cascaded from the original WHERE clause, representing the individual conditions extracted from the original logical expression.
 * @property {ExpressionNode[]} orderedSelections - An array of selection expressions that have been ordered based on their complexity and the number of referenced tables, which helps determine the optimal order of evaluation during execution.
 * @property {Record<string, ExpressionNode[]>} pushedSelectionsByTable - An object mapping table names to arrays of selection expressions that have been pushed down to be evaluated at the level of the respective table, allowing for more efficient filtering during data retrieval.
 * @property {ExpressionNode[]} residualSelections - An array of selection expressions that could not be pushed down to specific tables and must be evaluated at a higher level during execution, typically after joins are performed.
 * @property {Record<string, string[]>} projectionByTable - An object mapping table names to arrays of column names that need to be projected (selected) from each table, which is determined based on the columns referenced in the SELECT clause and any selections that were pushed down.
 * @property {JoinNode[]} introducedJoins - An array of JOIN nodes that were introduced during optimization to replace selection conditions that reference multiple tables, allowing those conditions to be evaluated as part of the join operation rather than as residual selections.
 * @property {FromNode[]} optimizedFrom - An array of FROM clause nodes that represent the optimized structure of the FROM clause after introducing joins and potentially reordering tables.
 * @property {ExpressionNode} [optimizedWhere] - An optional expression node representing the optimized WHERE clause, which is composed of any residual selections that could not be pushed down or transformed into joins, combined into a single logical expression if necessary.
 */
export interface SelectOptimizationResult {
  cascadedSelections: ExpressionNode[];
  orderedSelections: ExpressionNode[];
  pushedSelectionsByTable: Record<string, ExpressionNode[]>;
  residualSelections: ExpressionNode[];
  projectionByTable: Record<string, string[]>;
  introducedJoins: JoinNode[];
  optimizedFrom: FromNode[];
  optimizedWhere?: ExpressionNode;
}

/**
 * Implements optimization strategies for SELECT statements, including cascading and commutating selections, pushing selections down to tables, introducing joins for multi-table conditions, and determining necessary projections. The SelectOptimizer analyzes the structure of the SELECT statement and transforms it to improve execution efficiency while preserving the semantics of the original query. It produces an optimization result that can be used by the SelectExecutor to execute the query with enhanced performance.
 * @class SelectOptimizer
 */
export class SelectOptimizer {
  /**
   * Optimizes a SELECT statement by applying various transformations to the WHERE clause, FROM clause, and SELECT columns. This includes cascading and commutating selection conditions, pushing selections down to the level of individual tables, introducing JOINs for conditions that reference multiple tables, and determining the necessary projections for each table based on the columns referenced in the SELECT clause and the selection conditions.
   * @param statement The parsed SELECT statement AST node to optimize.
   * @returns {SelectOptimizationResult} An object containing the results of the optimization process, including transformed AST nodes and metadata for execution.
   */
  optimize(statement: SelectStatement): SelectOptimizationResult {
    const cascadedSelections = this.cascadeSelections(statement.where);
    const orderedSelections = this.commutateSelections(cascadedSelections);

    const { optimizedFrom, introducedJoins, remainingSelections } = this.introduceJoins(
      statement.from,
      orderedSelections,
    );
    const { pushedSelectionsByTable, residualSelections } = this.pushSelections(optimizedFrom, remainingSelections);
    const projectionByTable = this.pushProjection(
      statement.columns,
      optimizedFrom,
      pushedSelectionsByTable,
      residualSelections,
      introducedJoins,
    );

    return {
      cascadedSelections,
      orderedSelections,
      pushedSelectionsByTable,
      residualSelections,
      projectionByTable,
      introducedJoins,
      optimizedFrom,
      optimizedWhere: this.composeAndExpression(remainingSelections),
    };
  }

  /**
   * Cascades selection conditions by recursively extracting all AND-ed sub-expressions from a logical expression.
   * @param where The WHERE clause expression to cascade.
   * @returns {ExpressionNode[]} An array of cascaded selection conditions.
   */
  private cascadeSelections(where?: ExpressionNode): ExpressionNode[] {
    if (!where) {
      return [];
    }

    if (where.type === 'LogicalExpression' && where.operator === 'AND') {
      return [...this.cascadeSelections(where.left), ...this.cascadeSelections(where.right)];
    }

    return [where];
  }

  /**
   * Commutates selection conditions by ordering them based on the number of referenced tables and their complexity, which can help optimize the execution order during query processing. Conditions that reference fewer tables and are less complex are typically evaluated first to reduce the number of rows processed in subsequent conditions.
   * @param selections An array of selection conditions to commutate.
   * @returns {ExpressionNode[]} An array of commutated selection conditions.
   */
  private commutateSelections(selections: ExpressionNode[]): ExpressionNode[] {
    return [...selections].sort((left, right) => {
      const leftTables = this.getReferencedTables(left).size;
      const rightTables = this.getReferencedTables(right).size;

      if (leftTables !== rightTables) {
        return leftTables - rightTables;
      }

      return this.expressionComplexity(left) - this.expressionComplexity(right);
    });
  }

  /**
   * Pushes selection conditions down to the level of individual tables when possible, based on the tables referenced in each selection condition. Conditions that reference only a single table can be evaluated at the level of that table, while conditions that reference multiple tables must be evaluated as residual selections after joins are performed. This method returns an object mapping table names to their respective pushed selections, as well as an array of residual selections that could not be pushed down.
   * @param from The FROM clause nodes.
   * @param selections The selection conditions to push down.
   * @returns {{ pushedSelectionsByTable: Record<string, ExpressionNode[]>, residualSelections: ExpressionNode[] }} An object containing pushed selections by table and residual selections.
   */
  private pushSelections(
    from: FromNode[],
    selections: ExpressionNode[],
  ): {
    pushedSelectionsByTable: Record<string, ExpressionNode[]>;
    residualSelections: ExpressionNode[];
  } {
    const tableNames = this.extractTableNames(from);
    const pushedSelectionsByTable: Record<string, ExpressionNode[]> = {};
    tableNames.forEach((table) => {
      pushedSelectionsByTable[table] = [];
    });

    const residualSelections: ExpressionNode[] = [];

    selections.forEach((selection) => {
      const referencedTables = Array.from(this.getReferencedTables(selection));

      if (referencedTables.length === 1 && tableNames.includes(referencedTables[0])) {
        pushedSelectionsByTable[referencedTables[0]].push(selection);
        return;
      }

      residualSelections.push(selection);
    });

    return { pushedSelectionsByTable, residualSelections };
  }

  /**
   * Pushes projection requirements down to individual tables based on the columns referenced in the SELECT clause, as well as any columns referenced in selection conditions (both pushed and residual) and introduced JOIN conditions. This method determines which columns need to be projected from each table to ensure that all necessary data is available for evaluating selection conditions and producing the final result set, while avoiding unnecessary column retrieval for improved performance.
   * @param columns The columns specified in the SELECT clause, which may include identifiers and aggregate function nodes.
   * @param from The optimized FROM clause nodes after introducing joins.
   * @param pushedSelectionsByTable The pushed selection conditions by table.
   * @param residualSelections The residual selection conditions.
   * @param introducedJoins The introduced JOIN nodes.
   * @returns {{ [table: string]: string[] }} An object mapping table names to their respective projected columns.
   */
  private pushProjection(
    columns: SelectColumn[],
    from: FromNode[],
    pushedSelectionsByTable: Record<string, ExpressionNode[]>,
    residualSelections: ExpressionNode[],
    introducedJoins: JoinNode[],
  ): Record<string, string[]> {
    const tableNames = this.extractTableNames(from);
    const projectionByTable: Record<string, Set<string>> = {};

    tableNames.forEach((table) => {
      projectionByTable[table] = new Set<string>();
    });

    if (columns.some((column) => column.type === 'Identifier' && column.name === '*')) {
      return this.materializeWildcardProjection(tableNames);
    }

    columns.forEach((column) => {
      if (column.type === 'Identifier') {
        this.addIdentifierToProjection(column, projectionByTable, tableNames);
        return;
      }

      if (column.argument.type === 'Wildcard') {
        tableNames.forEach((table) => projectionByTable[table].add('*'));
        return;
      }

      this.addIdentifierToProjection(column.argument, projectionByTable, tableNames);
    });

    Object.entries(pushedSelectionsByTable).forEach(([table, selections]) => {
      selections.forEach((selection) => {
        this.collectIdentifiersFromExpression(selection).forEach((identifier) => {
          this.addIdentifierToProjection(identifier, projectionByTable, tableNames, table);
        });
      });
    });

    residualSelections.forEach((selection) => {
      this.collectIdentifiersFromExpression(selection).forEach((identifier) => {
        this.addIdentifierToProjection(identifier, projectionByTable, tableNames);
      });
    });

    introducedJoins.forEach((join) => {
      if (!join.on) {
        return;
      }

      this.collectIdentifiersFromExpression(join.on).forEach((identifier) => {
        this.addIdentifierToProjection(identifier, projectionByTable, tableNames);
      });
    });

    const materialized: Record<string, string[]> = {};
    tableNames.forEach((table) => {
      materialized[table] = Array.from(projectionByTable[table]);
    });

    return materialized;
  }

  /**
   * Introduces JOIN nodes into the FROM clause for selection conditions that reference multiple tables, transforming those conditions into join predicates. This method identifies selection conditions that can be converted into JOINs, modifies the FROM clause accordingly by replacing referenced tables with JOIN nodes, and returns the optimized FROM clause along with any introduced JOINs and remaining selection conditions that could not be transformed.
   * @param from The original FROM clause nodes before optimization.
   * @param selections The selection conditions to be optimized.
   * @returns { optimizedFrom: FromNode[]; introducedJoins: JoinNode[]; remainingSelections: ExpressionNode[] } An object containing the optimized FROM clause, introduced JOINs, and remaining selection conditions.
   */
  private introduceJoins(
    from: FromNode[],
    selections: ExpressionNode[],
  ): {
    optimizedFrom: FromNode[];
    introducedJoins: JoinNode[];
    remainingSelections: ExpressionNode[];
  } {
    const workingFrom: FromNode[] = [...from];
    const introducedJoins: JoinNode[] = [];
    const remainingSelections: ExpressionNode[] = [];

    selections.forEach((selection) => {
      const joinCandidate = this.toJoinCandidate(selection, workingFrom);
      if (!joinCandidate) {
        remainingSelections.push(selection);
        return;
      }

      const { rightTable, joinNode } = joinCandidate;
      const rightIndex = workingFrom.findIndex((node) => node.type === 'Table' && node.name === rightTable);

      if (rightIndex === -1) {
        remainingSelections.push(selection);
        return;
      }

      workingFrom.splice(rightIndex, 1);
      workingFrom.push(joinNode);
      introducedJoins.push(joinNode);
    });

    return {
      optimizedFrom: workingFrom,
      introducedJoins,
      remainingSelections,
    };
  }

  /**
   * Converts a selection condition into a JOIN candidate if it is a comparison expression that references identifiers from two different tables. This method checks if the selection condition is a simple equality comparison between two identifiers, determines the tables referenced by those identifiers, and if they reference different tables that are both present in the FROM clause, it constructs a JOIN node that can be introduced into the FROM clause to replace the original selection condition.
   * @param selection The selection condition to evaluate as a potential JOIN candidate, which is an expression node that may represent a comparison between columns from different tables.
   * @param from The current FROM clause nodes, which are used to determine if the referenced tables in the selection condition are present and to validate the JOIN candidate.
   * @returns {{ rightTable: string; joinNode: JoinNode } | undefined}} An object containing the right table name and the constructed JOIN node if the selection can be transformed into a JOIN, or undefined if it cannot be transformed.
   */
  private toJoinCandidate(
    selection: ExpressionNode,
    from: FromNode[],
  ): { rightTable: string; joinNode: JoinNode } | undefined {
    if (selection.type !== 'ComparisonExpression' || selection.operator !== '=') {
      return undefined;
    }

    if (selection.left.type !== 'Identifier' || selection.right.type !== 'Identifier') {
      return undefined;
    }

    const leftTable = this.identifierTable(selection.left.name);
    const rightTable = this.identifierTable(selection.right.name);

    if (!leftTable || !rightTable || leftTable === rightTable) {
      return undefined;
    }

    const tablesInFrom = this.extractTableNames(from);
    if (!tablesInFrom.includes(leftTable) || !tablesInFrom.includes(rightTable)) {
      return undefined;
    }

    return {
      rightTable,
      joinNode: {
        type: 'Join',
        joinType: 'INNER',
        table: { type: 'Table', name: rightTable },
        on: selection,
      },
    };
  }

  /**
   * Composes an optimized WHERE clause by combining residual selection conditions into a single logical expression using AND operators. If there are no residual selections, it returns undefined, indicating that there is no WHERE clause needed after optimization. If there is only one residual selection, it returns that selection as the optimized WHERE clause. If there are multiple residual selections, it constructs a LogicalExpression node that combines them with AND operators to ensure that all conditions are applied during execution.
   * @param expressions The array of residual selection expressions that need to be combined into a single WHERE clause expression.
   * @returns {ExpressionNode | undefined} An expression node representing the optimized WHERE clause, or undefined if there are no residual selections.
   */
  private composeAndExpression(expressions: ExpressionNode[]): ExpressionNode | undefined {
    if (expressions.length === 0) {
      return undefined;
    }

    return expressions.reduce((left, right) => {
      return {
        type: 'LogicalExpression',
        operator: 'AND',
        left,
        right,
      };
    });
  }

  /**
   * Collects all identifier nodes from a given expression.
   * @param expression The expression node to analyze for identifier nodes.
   * @returns {IdentifierNode[]} An array of identifier nodes found within the expression.
   */
  private collectIdentifiersFromExpression(expression: ExpressionNode): IdentifierNode[] {
    switch (expression.type) {
      case 'ComparisonExpression':
        return [
          ...this.collectIdentifiersFromValueExpression(expression.left),
          ...this.collectIdentifiersFromValueExpression(expression.right),
        ];
      case 'LogicalExpression':
        return [
          ...this.collectIdentifiersFromExpression(expression.left),
          ...this.collectIdentifiersFromExpression(expression.right),
        ];
      case 'NotExpression':
        return this.collectIdentifiersFromExpression(expression.expression);
      case 'NullCheckExpression':
        return [expression.left];
      case 'InExpression':
        return [expression.left];
      default:
        return [];
    }
  }

  /**
   * Collects all identifier nodes from a given value expression.
   * @param expression The value expression node to analyze for identifier nodes.
   * @returns {IdentifierNode[]} An array of identifier nodes found within the value expression.
   */
  private collectIdentifiersFromValueExpression(expression: ValueExpressionNode): IdentifierNode[] {
    switch (expression.type) {
      case 'Identifier':
        return [expression];
      case 'ArithmeticExpression':
        return [
          ...this.collectIdentifiersFromValueExpression(expression.left),
          ...this.collectIdentifiersFromValueExpression(expression.right),
        ];
      case 'AggregateFunction':
        return expression.argument.type === 'Identifier' ? [expression.argument] : [];
      default:
        return [];
    }
  }

  /**
   * Adds an identifier node to the appropriate projection set based on its table reference.
   * @param identifier The identifier node to add.
   * @param projectionByTable The record mapping table names to their respective projection sets.
   * @param tableNames The list of table names in the query.
   * @param fallbackTable The default table to use if no explicit table is found.
   * @returns {void}
   */
  private addIdentifierToProjection(
    identifier: IdentifierNode,
    projectionByTable: Record<string, Set<string>>,
    tableNames: string[],
    fallbackTable?: string,
  ): void {
    const explicitTable = this.identifierTable(identifier.name);
    if (explicitTable && projectionByTable[explicitTable]) {
      projectionByTable[explicitTable].add(this.identifierColumn(identifier.name));
      return;
    }

    if (fallbackTable && projectionByTable[fallbackTable]) {
      projectionByTable[fallbackTable].add(this.identifierColumn(identifier.name));
      return;
    }

    if (tableNames.length === 1) {
      projectionByTable[tableNames[0]].add(this.identifierColumn(identifier.name));
    }
  }

  /**
   * Gets the set of table names referenced by an expression node by collecting all identifier nodes within the expression and extracting their table references. This is used to determine which tables are involved in a selection condition, which helps in deciding whether the condition can be pushed down to a specific table or if it needs to be evaluated as a residual selection after joins.
   * @param expression The expression node to analyze for referenced tables, which may include various types of expressions such as comparisons, logical expressions, and function calls that can contain identifiers referencing different tables.
   * @returns {Set<string>} A set of table names that are referenced by the identifiers found within the expression node.
   */
  private getReferencedTables(expression: ExpressionNode): Set<string> {
    const identifiers = this.collectIdentifiersFromExpression(expression);
    const tables = new Set<string>();

    identifiers.forEach((identifier) => {
      const table = this.identifierTable(identifier.name);
      if (table) {
        tables.add(table);
      }
    });

    return tables;
  }

  /**
   * Extracts the names of tables from a list of FROM nodes.
   * @param from The list of FROM nodes.
   * @returns {string[]} An array of table names.
   */
  private extractTableNames(from: FromNode[]): string[] {
    const names: string[] = [];

    from.forEach((node) => {
      if (node.type === 'Table') {
        names.push(node.name);
        return;
      }

      names.push(node.table.name);
    });

    return names;
  }

  /**
   * Determines the complexity of an expression node based on its type, which can be used to order selection conditions during optimization. Simpler expressions (e.g., comparisons) are considered less complex than more complex expressions (e.g., logical expressions), which can help in deciding the optimal order of evaluation during query execution.
   * @param expression The expression node to evaluate for complexity.
   * @returns {number} A numeric value representing the complexity of the expression, where lower values indicate simpler expressions and higher values indicate more complex expressions.
   */
  private expressionComplexity(expression: ExpressionNode): number {
    switch (expression.type) {
      case 'ComparisonExpression':
        return 1;
      case 'NullCheckExpression':
      case 'InExpression':
        return 2;
      case 'NotExpression':
        return 3;
      case 'LogicalExpression':
        return 4;
      default:
        return 5;
    }
  }

  /**
   * Extracts the table name from an identifier string that may be in the format "table.column". If the identifier does not contain a dot, it returns undefined, indicating that there is no explicit table reference in the identifier.
   * @param name The identifier string to analyze, which may include a table reference followed by a column name (e.g., "tableName.columnName").
   * @returns {string | undefined} The extracted table name if present, or undefined if there is no explicit table reference in the identifier.
   */
  private identifierTable(name: string): string | undefined {
    const split = name.split('.');
    if (split.length < 2) {
      return undefined;
    }

    return split[0];
  }

  /**
   * Extracts the column name from an identifier string that may be in the format "table.column". If the identifier does not contain a dot, it returns the entire identifier as the column name.
   * @param name The identifier string to analyze, which may include a table reference followed by a column name (e.g., "tableName.columnName").
   * @returns {string} The extracted column name, which is the part of the identifier after the last dot if a table reference is present, or the entire identifier if there is no dot.
   */
  private identifierColumn(name: string): string {
    const split = name.split('.');
    return split[split.length - 1];
  }

  /**
   * Generates a projection mapping for all tables when a wildcard (*) is used in the SELECT clause, indicating that all columns from all tables should be projected. This method creates a projection object where each table name maps to an array containing a single string '*', which signals that all columns from that table should be included in the result set.
   * @param tableNames The list of table names for which to generate the wildcard projection, which are the tables present in the FROM clause of the query.
   * @returns {Record<string, string[]>} An object mapping each table name to an array containing the string '*', indicating that all columns from each table should be projected.
   */
  private materializeWildcardProjection(tableNames: string[]): Record<string, string[]> {
    const projection: Record<string, string[]> = {};
    tableNames.forEach((table) => {
      projection[table] = ['*'];
    });
    return projection;
  }
}
