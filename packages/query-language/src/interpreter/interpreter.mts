//@author Tijn Gommers
//@date 2026-03-30

import type { ASTNode, DeleteStatement, InsertStatement, SelectStatement, UpdateStatement } from '../types/index.mjs';
import { Parser } from '../parser/parser.mjs';
import { Lexer } from '../lexer/lexer.mjs';
import { SelectExecutor, DeleteExecutor, InsertExecutor, UpdateExecutor } from '../executors/index.mjs';
import type { StorageAdapter } from '../../storage-adapter/storage-adapter.mjs';
import type { QueryExecutionResult } from '../types/execution-results.mjs';

/**
 * Parses a query string and dispatches execution to the correct statement executor.
 * @class Interpreter
 */
export class Interpreter {
  private ast: ASTNode;
  private selectExecutor: SelectExecutor;
  private deleteExecutor: DeleteExecutor;
  private insertExecutor: InsertExecutor;
  private updateExecutor: UpdateExecutor;

  /**
   * Creates an interpreter for a single query.
   * @param query Query-language statement string.
   * @param storageAdapter Optional storage adapter for persistent operations.
   * @throws {Error} When lexing or parsing the query fails.
   */
  constructor(query: string, storageAdapter?: StorageAdapter) {
    const lexer = new Lexer(query);
    const parser = new Parser(lexer);
    this.ast = parser.parse();
    this.selectExecutor = new SelectExecutor(storageAdapter);
    this.deleteExecutor = new DeleteExecutor(storageAdapter);
    this.insertExecutor = new InsertExecutor(storageAdapter);
    this.updateExecutor = new UpdateExecutor(storageAdapter);
  }

  /**
   * Executes the parsed statement by dispatching on AST node type.
   * @returns {QueryExecutionResult | Promise<QueryExecutionResult>} Statement result object or a Promise-backed result for adapter operations.
   * @throws {Error} When the AST node type is unsupported.
   */
  execute(ids: string[] = [], userId: string = 'NO_USER'): QueryExecutionResult | Promise<QueryExecutionResult> {
    switch (this.ast.type) {
      case 'SelectStatement':
        return this.executeSelectStatement(this.ast);
      case 'DeleteStatement':
        return this.executeDeleteStatement(this.ast);
      case 'InsertStatement':
        return this.executeInsertStatement(this.ast, ids, userId);
      case 'UpdateStatement':
        return this.executeUpdateStatement(this.ast);
      default:
        return this.assertNever(this.ast);
    }
  }

  identifyType(): string {
    switch (this.ast.type) {
      case 'SelectStatement':
        return 'SELECT';
      case 'DeleteStatement':
        return 'DELETE';
      case 'InsertStatement':
        return 'INSERT';
      case 'UpdateStatement':
        return 'UPDATE';
      default:
        return this.assertNever(this.ast);
    }
  }

  /**
   * Executes a parsed SELECT statement.
   * @param ast Parsed SELECT AST node.
   * @returns {QueryExecutionResult | Promise<QueryExecutionResult>} SELECT execution result.
   */
  private executeSelectStatement(ast: SelectStatement): QueryExecutionResult | Promise<QueryExecutionResult> {
    return this.selectExecutor.executeSelect(ast);
  }

  /**
   * Executes a parsed DELETE statement.
   * @param ast Parsed DELETE AST node.
   * @returns {QueryExecutionResult | Promise<QueryExecutionResult>} DELETE execution result.
   */
  private executeDeleteStatement(ast: DeleteStatement): QueryExecutionResult | Promise<QueryExecutionResult> {
    return this.deleteExecutor.executeDelete(ast);
  }

  /**
   * Executes a parsed INSERT statement.
   * @param ast Parsed INSERT AST node.
   * @returns {QueryExecutionResult | Promise<QueryExecutionResult>} INSERT execution result.
   */
  private executeInsertStatement(
    ast: InsertStatement,
    ids: string[] = [],
    userId: string = 'NO_USER',
  ): QueryExecutionResult | Promise<QueryExecutionResult> {
    return this.insertExecutor.executeInsert(ast, [], ids, userId);
  }

  amountOfRows(): number {
    const n: InsertStatement = this.ast as InsertStatement;
    return this.insertExecutor.amountOfRows(n);
  }

  /**
   * Executes a parsed UPDATE statement.
   * @param ast Parsed UPDATE AST node.
   * @returns {QueryExecutionResult | Promise<QueryExecutionResult>} UPDATE execution result.
   */
  private executeUpdateStatement(ast: UpdateStatement): QueryExecutionResult | Promise<QueryExecutionResult> {
    return this.updateExecutor.executeUpdate(ast);
  }

  /**
   * Exhaustiveness guard for AST node dispatch.
   * @param value Unexpected AST value.
   * @returns {QueryExecutionResult | Promise<QueryExecutionResult>} Never returns; always throws.
   * @throws {Error} Always thrown to signal unsupported AST node types.
   */
  private assertNever(value: never): never {
    throw new Error(`Unknown AST node: ${JSON.stringify(value)}`);
  }
}
