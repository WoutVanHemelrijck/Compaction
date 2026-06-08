// @author Tijn Gommers
// @date 2026-03-30

import { TokenType } from '../types/index.mjs';
import type {
  ASTNode,
  DeleteStatement,
  ExpressionNode,
  FromNode,
  IdentifierNode,
  InsertStatement,
  JoinNode,
  LimitOffsetNode,
  OrderByStatement,
  OrderByItem,
  SelectColumn,
  SelectStatement,
  TableNode,
  ValueNode,
  WildcardNode,
  UpdateStatement,
} from '../types/index.mjs';
import { Lexer } from '../lexer/lexer.mjs';
import { ParserCursor } from './parser-cursor.mjs';
import { isAggregateFunctionToken, parseAggregateFunctionName } from './parser-helpers.mjs';
import { ValueParser } from './value-parser.mjs';
import { ExpressionParser } from './expression-parser.mjs';

/**
 * Parses token streams into query-language AST statements.
 * Grammar reference: ../../GRAMMAR.ebnf
 * @class Parser
 */
export class Parser {
  private cursor: ParserCursor;
  private valueParser: ValueParser;
  private expressionParser: ExpressionParser;

  /**
   * Creates a parser for a lexer token stream.
   * @param lexer Lexer providing tokenized input.
   */
  constructor(lexer: Lexer) {
    this.cursor = new ParserCursor(lexer);
    this.valueParser = new ValueParser(this.cursor);
    this.expressionParser = new ExpressionParser(this.cursor, this.valueParser);
  }

  /**
   * Parses the input into a top-level AST statement.
   * @grammar query
   * @returns Parsed AST statement.
   * @throws {Error} When the initial token does not match a supported statement type.
   */
  parse(): ASTNode {
    if (this.cursor.currentType() === TokenType.SELECT) {
      return this.parseSelect();
    }

    if (this.cursor.currentType() === TokenType.DELETE) {
      return this.parseDelete();
    }

    if (this.cursor.currentType() === TokenType.INSERT) {
      return this.parseInsert();
    }

    if (this.cursor.currentType() === TokenType.UPDATE) {
      return this.parseUpdate();
    }

    throw new Error(`Unexpected token: ${this.cursor.currentType()}`);
  }

  /**
   * Parses a SELECT statement.
   * @grammar selectStatement
   * @returns {SelectStatement} SELECT statement AST node.
   * @throws {Error} When SELECT syntax is invalid.
   * @example SELECT DISTINCT name, COUNT(*) FROM users WHERE age > 18 GROUP BY name HAVING COUNT(*) > 1 ORDER BY name DESC LIMIT 10 OFFSET 5
   */
  private parseSelect(): SelectStatement {
    this.cursor.eat(TokenType.SELECT);

    let distinct = false;
    if (this.cursor.currentType() === TokenType.DISTINCT) {
      distinct = true;
      this.cursor.eat(TokenType.DISTINCT);
    }

    const columns = this.parseSelectColumns();

    const from = this.parseSelectFrom();
    let where: ExpressionNode | undefined;
    let groupBy: IdentifierNode[] | undefined;
    let having: ExpressionNode | undefined;

    let orderBy: OrderByStatement | undefined;
    let limit: LimitOffsetNode | undefined;

    if (this.cursor.currentType() === TokenType.WHERE) {
      where = this.parseWhere();
    }

    if (this.cursor.currentType() === TokenType.GROUP) {
      groupBy = this.parseGroupBy();
    }

    if (this.cursor.currentType() === TokenType.HAVING) {
      if (!groupBy) {
        throw new Error('HAVING clause requires GROUP BY');
      }
      having = this.parseHaving();
    }

    if (this.cursor.currentType() === TokenType.ORDER) {
      orderBy = this.parseOrderBy();
    }

    if (this.cursor.currentType() === TokenType.LIMIT) {
      limit = this.parseLimitOffset();
    }

    return { type: 'SelectStatement', distinct, from, columns, where, groupBy, having, orderBy, limit };
  }

  /**
   * Parses a DELETE statement.
   * @grammar deleteStatement
   * @returns {DeleteStatement} DELETE statement AST node.
   * @throws {Error} When DELETE syntax is invalid.
   * @example DELETE FROM users WHERE age < 18
   */
  private parseDelete(): DeleteStatement {
    this.cursor.eat(TokenType.DELETE);

    const from = this.parseDeleteFrom();
    let where: ExpressionNode | undefined;
    if (this.cursor.currentType() === TokenType.WHERE) {
      where = this.parseWhere();
      return { type: 'DeleteStatement', from, where };
    }

    return { type: 'DeleteStatement', from, where: undefined };
  }

  /**
   * Parses an INSERT statement.
   * @grammar insertStatement
   * @returns {InsertStatement} INSERT statement AST node.
   * @throws {Error} When INSERT syntax is invalid.
   * @example INSERT INTO users (name, age) VALUES ('Alice', 30), ('Bob', 25)
   */
  private parseInsert(): InsertStatement {
    this.cursor.eat(TokenType.INSERT);
    this.cursor.eat(TokenType.INTO);

    if (this.cursor.currentType() !== TokenType.IDENTIFIER) {
      throw new Error(`Expected table name after INTO but got ${this.cursor.currentType()}`);
    }

    const table: TableNode = { type: 'Table', name: this.cursor.currentValue() };
    this.cursor.eat(TokenType.IDENTIFIER);

    const columns = this.parseInsertColumns();

    if (this.cursor.currentType() !== TokenType.VALUES) {
      throw new Error(`Expected VALUES after table name but got ${this.cursor.currentType()}`);
    }

    this.cursor.eat(TokenType.VALUES);

    if (this.cursor.currentType() !== TokenType.LEFT_PAREN) {
      throw new Error(`Expected at least one values tuple after VALUES but got ${this.cursor.currentType()}`);
    }

    const values: ValueNode[][] = [];
    values.push(this.parseInsertValues());

    if (values[0].length !== columns.length) {
      throw new Error(`Column count ${columns.length} does not match values count ${values[0].length}`);
    }

    while (this.cursor.currentType() === TokenType.COMMA) {
      this.cursor.eat(TokenType.COMMA);
      if (this.cursor.currentType() !== TokenType.LEFT_PAREN) {
        throw new Error(`Expected values tuple after COMMA but got ${this.cursor.currentType()}`);
      }

      const tuple = this.parseInsertValues();
      if (tuple.length !== columns.length) {
        throw new Error(`Column count ${columns.length} does not match values count ${tuple.length}`);
      }

      values.push(tuple);
    }

    if (this.cursor.currentType() !== TokenType.EOF) {
      throw new Error(`Unexpected token after INSERT values: ${this.cursor.currentType()}`);
    }

    return { type: 'InsertStatement', table, columns, values };
  }

  /**
   * Parses an UPDATE statement.
   * @grammar updateStatement
   * @returns {UpdateStatement} UPDATE statement AST node.
   * @throws {Error} When UPDATE syntax is invalid.
   * @example UPDATE users SET name = 'Alice', age = 30 WHERE id = 1
   */
  private parseUpdate(): UpdateStatement {
    this.cursor.eat(TokenType.UPDATE);

    if (this.cursor.currentType() !== TokenType.IDENTIFIER) {
      throw new Error(`Expected table name after UPDATE but got ${this.cursor.currentType()}`);
    }

    const table: TableNode = { type: 'Table', name: this.cursor.currentValue() };
    this.cursor.eat(TokenType.IDENTIFIER);

    if (this.cursor.currentType() !== TokenType.SET) {
      throw new Error(`Expected SET after table name but got ${this.cursor.currentType()}`);
    }

    this.cursor.eat(TokenType.SET);
    const set: { column: IdentifierNode; value: ValueNode }[] = [];
    set.push(this.parseUpdateSetClause());

    while (this.cursor.currentType() === TokenType.COMMA) {
      this.cursor.eat(TokenType.COMMA);
      set.push(this.parseUpdateSetClause());
    }

    let where: ExpressionNode | undefined;
    if (this.cursor.currentType() === TokenType.WHERE) {
      where = this.parseWhere();
      return { type: 'UpdateStatement', table, set, where };
    }

    return { type: 'UpdateStatement', table, set, where: undefined };
  }

  /**
   * Parses one SET assignment in an UPDATE statement.
   * @returns {Column/value assignment object} Column/value assignment object.
   * @throws {Error} When assignment syntax is invalid.
   * @example Parses "name = 'Alice'" as { column: { type: 'Identifier', name: 'name' }, value: { type: 'Literal', valueType: 'string', value: 'Alice' } }
   */
  private parseUpdateSetClause(): { column: IdentifierNode; value: ValueNode } {
    if (this.cursor.currentType() !== TokenType.IDENTIFIER) {
      throw new Error(`Expected column name after SET but got ${this.cursor.currentType()}`);
    }

    const column: IdentifierNode = { type: 'Identifier', name: this.cursor.currentValue() };
    this.cursor.eat(TokenType.IDENTIFIER);

    if (this.cursor.currentType() !== TokenType.EQUALS) {
      throw new Error(`Expected = after column name but got ${this.cursor.currentType()}`);
    }

    this.cursor.eat(TokenType.EQUALS);
    const value: ValueNode = this.valueParser.parseValueNode();

    return { column, value };
  }

  /**
   * Parses the column list of an INSERT statement.
   * @returns {IdentifierNode[]} Array of identifier columns.
   * @throws {Error} When INSERT column-list syntax is invalid.
   * @example Parses "(name, age)" as [{ type: 'Identifier', name: 'name' }, { type: 'Identifier', name: 'age' }]
   */
  private parseInsertColumns(): IdentifierNode[] {
    const columns: IdentifierNode[] = [];

    if (this.cursor.currentType() !== TokenType.LEFT_PAREN) {
      throw new Error(`Expected ( after table name but got ${this.cursor.currentType()}`);
    }

    this.cursor.eat(TokenType.LEFT_PAREN);

    if (this.cursor.currentType() !== TokenType.IDENTIFIER) {
      throw new Error(`Expected column name after ( but got ${this.cursor.currentType()}`);
    }

    columns.push(this.valueParser.parseIdentifierNode('INSERT column list'));

    while (this.cursor.currentType() === TokenType.COMMA) {
      this.cursor.eat(TokenType.COMMA);
      if (this.cursor.currentType() !== TokenType.IDENTIFIER) {
        throw new Error(`Expected column name after COMMA but got ${this.cursor.currentType()}`);
      }
      columns.push(this.valueParser.parseIdentifierNode('INSERT column list'));
    }
    this.cursor.eat(TokenType.RIGHT_PAREN);
    return columns;
  }

  /**
   * Parses one VALUES tuple from an INSERT statement.
   * @returns {ValueNode[]} Array of value nodes for a single tuple.
   * @throws {Error} When VALUES tuple syntax is invalid.
   * @example Parses "('Alice', 30)" as [{ type: 'Literal', valueType: 'string', value: 'Alice' }, { type: 'Literal', valueType: 'number', value: 30 }]
   */
  private parseInsertValues(): ValueNode[] {
    const values: ValueNode[] = [];

    if (this.cursor.currentType() !== TokenType.LEFT_PAREN) {
      throw new Error(`Expected ( before VALUES but got ${this.cursor.currentType()}`);
    }
    this.cursor.eat(TokenType.LEFT_PAREN);

    if (this.cursor.currentType() === TokenType.RIGHT_PAREN) {
      throw new Error(`Expected at least one value in VALUES tuple but got ${this.cursor.currentType()}`);
    }

    values.push(this.valueParser.parseValueNode());
    while (this.cursor.currentType() === TokenType.COMMA) {
      this.cursor.eat(TokenType.COMMA);
      values.push(this.valueParser.parseValueNode());
    }
    this.cursor.eat(TokenType.RIGHT_PAREN);

    return values;
  }

  /**
   * Parses the SELECT column list.
   * @returns {SelectColumn[]} Array of select columns.
   * @throws {Error} When SELECT column syntax is invalid.
   * @example Parses "name, COUNT(*)" as [{ type: 'Identifier', name: 'name' }, { type: 'AggregateFunction', functionName: 'COUNT', argument: { type: 'Wildcard', value: '*' } }]
   */
  private parseSelectColumns(): SelectColumn[] {
    const columns: SelectColumn[] = [];

    if (!this.isValidSelectColumnStart(this.cursor.currentType())) {
      throw new Error(`Expected at least one column after SELECT but got ${this.cursor.currentType()}`);
    }

    if (this.cursor.currentType() === TokenType.STAR) {
      columns.push({ type: 'Identifier', name: '*' });
      this.cursor.eat(TokenType.STAR);
      return columns;
    }

    columns.push(this.parseSelectColumn());

    while (this.cursor.currentType() === TokenType.COMMA) {
      this.cursor.eat(TokenType.COMMA);
      if (!this.isValidSelectColumnStart(this.cursor.currentType())) {
        throw new Error(`Expected column name after COMMA but got ${this.cursor.currentType()}`);
      }
      columns.push(this.parseSelectColumn());
    }

    return columns;
  }

  /**
   * Parses a single SELECT column expression.
   * @returns {SelectColumn} Parsed select column node.
   * @throws {Error} When unsupported function-call syntax is encountered.
   * @example Parses "COUNT(*)" as { type: 'AggregateFunction', functionName: 'COUNT', argument: { type: 'Wildcard', value: '*' } }
   * @example Parses "user.name" as { type: 'Identifier', name: 'user.name' }
   */
  private parseSelectColumn(): SelectColumn {
    if (isAggregateFunctionToken(this.cursor.currentType())) {
      return this.parseAggregateFunction();
    }

    const identifier = this.valueParser.parseIdentifierNode('SELECT clause');

    if (this.cursor.currentType() === TokenType.LEFT_PAREN) {
      throw new Error(`Unsupported function in SELECT clause: ${identifier.name}`);
    }

    return identifier;
  }

  /**
   * Parses an aggregate function used in SELECT columns.
   * @returns {SelectColumn} Aggregate-function select column node.
   * @throws {Error} When aggregate syntax is invalid.
   * @example Parses "COUNT(*)" as { type: 'AggregateFunction', functionName: 'COUNT', argument: { type: 'Wildcard', value: '*' } }
   */
  private parseAggregateFunction(): SelectColumn {
    const functionName = parseAggregateFunctionName(this.cursor, 'SELECT clause');
    this.cursor.eat(TokenType.LEFT_PAREN);

    let argument: IdentifierNode | WildcardNode;
    if (this.cursor.currentType() === TokenType.STAR) {
      if (functionName !== 'COUNT') {
        throw new Error('Only COUNT supports wildcard argument');
      }

      this.cursor.eat(TokenType.STAR);
      argument = { type: 'Wildcard', value: '*' };
    } else if (this.cursor.currentType() === TokenType.IDENTIFIER) {
      argument = this.valueParser.parseIdentifierNode('Aggregate function argument');
    } else {
      throw new Error(`Expected aggregate argument but got ${this.cursor.currentType()}`);
    }

    this.cursor.eat(TokenType.RIGHT_PAREN);
    return { type: 'AggregateFunction', functionName, argument };
  }

  /**
   * Checks whether a token can start a SELECT column.
   * @param tokenType Token type to inspect.
   * @returns {boolean} True when token is a valid SELECT-column starter.
   */
  private isValidSelectColumnStart(tokenType: TokenType): boolean {
    return tokenType === TokenType.STAR || tokenType === TokenType.IDENTIFIER || isAggregateFunctionToken(tokenType);
  }

  /**
   * Parses DELETE FROM table list.
   * @returns {TableNode[]} Array of table nodes.
   * @throws {Error} When FROM/table syntax is invalid or JOIN is used.
   * @example Parses "FROM users, orders" as [{ type: 'Table', name: 'users' }, { type: 'Table', name: 'orders' }]
   */
  private parseDeleteFrom(): TableNode[] {
    this.cursor.eat(TokenType.FROM);
    const tables: TableNode[] = [];

    if (this.cursor.currentType() !== TokenType.IDENTIFIER) {
      throw new Error(`Expected table name after FROM but got ${this.cursor.currentType()}`);
    }

    tables.push({ type: 'Table', name: this.cursor.currentValue() });
    this.cursor.eat(TokenType.IDENTIFIER);

    while (this.cursor.currentType() === TokenType.COMMA) {
      this.cursor.eat(TokenType.COMMA);
      if (this.cursor.currentType() !== TokenType.IDENTIFIER) {
        throw new Error(`Expected table name after COMMA but got ${this.cursor.currentType()}`);
      }
      tables.push({ type: 'Table', name: this.cursor.currentValue() });
      this.cursor.eat(TokenType.IDENTIFIER);
    }

    if (this.cursor.currentType() === TokenType.JOIN || this.cursor.currentType() === TokenType.CROSS) {
      throw new Error('JOIN is not supported in DELETE statements');
    }

    return tables;
  }

  /**
   * Parses SELECT FROM sources, including join forms.
   * @returns {FromNode[]} Array of table/join source nodes.
   * @throws {Error} When FROM/join syntax is invalid.
   * @example Parses "FROM users CROSS JOIN orders JOIN products ON users.product_id = products.id" as [{ type: 'Table', name: 'users' }, { type: 'Join', joinType: 'CROSS', table: { type: 'Table', name: 'orders' } }, { type: 'Join', joinType: 'INNER', table: { type: 'Table', name: 'products' }, on: { type: 'ComparisonExpression', left: { type: 'Identifier', name: 'users.product_id' }, operator: '=', right: { type: 'Identifier', name: 'products.id' } } }]
   */
  private parseSelectFrom(): FromNode[] {
    this.cursor.eat(TokenType.FROM);
    const tables: FromNode[] = [];

    if (this.cursor.currentType() !== TokenType.IDENTIFIER) {
      throw new Error(`Expected table name after FROM but got ${this.cursor.currentType()}`);
    }

    tables.push({ type: 'Table', name: this.cursor.currentValue() });
    this.cursor.eat(TokenType.IDENTIFIER);

    while (this.cursor.currentType() === TokenType.COMMA) {
      this.cursor.eat(TokenType.COMMA);
      if (this.cursor.currentType() !== TokenType.IDENTIFIER) {
        throw new Error(`Expected table name after COMMA but got ${this.cursor.currentType()}`);
      }
      tables.push({ type: 'Table', name: this.cursor.currentValue() });
      this.cursor.eat(TokenType.IDENTIFIER);
    }

    while (
      this.cursor.currentType() === TokenType.CROSS ||
      this.cursor.currentType() === TokenType.JOIN ||
      this.cursor.currentType() === TokenType.INNER ||
      this.cursor.currentType() === TokenType.LEFT ||
      this.cursor.currentType() === TokenType.RIGHT ||
      this.cursor.currentType() === TokenType.OUTER
    ) {
      tables.push(this.parseJoin());
    }

    return tables;
  }

  /**
   * Parses a WHERE clause expression.
   * @grammar whereClause
   * @returns {ExpressionNode} Parsed WHERE expression node.
   * @throws {Error} When WHERE expression syntax is invalid.
   * @example Parses "WHERE age > 18 AND name IS NOT NULL" as { type: 'LogicalExpression', operator: 'AND', left: { type: 'ComparisonExpression', left: { type: 'Identifier', name: 'age' }, operator: '>', right: { type: 'Literal', valueType: 'number', value: 18 } }, right: { type: 'IsNullExpression', identifier: { type: 'Identifier', name: 'name' }, not: true } }
   */
  private parseWhere(): ExpressionNode {
    this.cursor.eat(TokenType.WHERE);
    return this.expressionParser.parseWhereExpression();
  }

  /**
   * Parses a GROUP BY clause.
   * @returns {IdentifierNode[]} Group-by identifier list.
   * @throws {Error} When GROUP BY syntax is invalid.
   * @example Parses "GROUP BY name, age" as [{ type: 'Identifier', name: 'name' }, { type: 'Identifier', name: 'age' }]
   */
  private parseGroupBy(): IdentifierNode[] {
    this.cursor.eat(TokenType.GROUP);
    this.cursor.eat(TokenType.BY);

    const columns: IdentifierNode[] = [];

    if (this.cursor.currentType() !== TokenType.IDENTIFIER) {
      throw new Error(`Expected at least one column after GROUP BY but got ${this.cursor.currentType()}`);
    }
    columns.push(this.valueParser.parseIdentifierNode('GROUP BY clause'));

    while (this.cursor.currentType() === TokenType.COMMA) {
      this.cursor.eat(TokenType.COMMA);
      if (this.cursor.currentType() !== TokenType.IDENTIFIER) {
        throw new Error(`Expected column name after COMMA but got ${this.cursor.currentType()}`);
      }
      columns.push(this.valueParser.parseIdentifierNode('GROUP BY clause'));
    }
    return columns;
  }

  /**
   * Parses a HAVING clause expression.
   * @returns {ExpressionNode} Parsed HAVING expression node.
   * @throws {Error} When HAVING expression syntax is invalid.
   * @example Parses "HAVING COUNT(*) > 5" as { type: 'ComparisonExpression', left: { type: 'AggregateFunction', name: 'COUNT', arguments: [{ type: 'Wildcard' }] }, operator: '>', right: { type: 'Literal', valueType: 'number', value: 5 } }
   */
  private parseHaving(): ExpressionNode {
    this.cursor.eat(TokenType.HAVING);
    return this.expressionParser.parseHavingExpression();
  }

  /**
   * Parses an ORDER BY clause.
   * @returns {OrderByStatement} ORDER BY statement node.
   * @throws {Error} When ORDER BY syntax is invalid.
   * @example Parses "ORDER BY name DESC, age ASC" as { type: 'OrderByStatement', items: [{ column: { type: 'Identifier', name: 'name' }, direction: 'DESC' }, { column: { type: 'Identifier', name: 'age' }, direction: 'ASC' }] }
   */
  private parseOrderBy(): OrderByStatement {
    this.cursor.eat(TokenType.ORDER);
    this.cursor.eat(TokenType.BY);

    const items: OrderByItem[] = [];

    if (this.cursor.currentType() !== TokenType.IDENTIFIER) {
      throw new Error(`Expected at least one column after ORDER BY but got ${this.cursor.currentType()}`);
    }

    while (true) {
      const column = this.valueParser.parseIdentifierNode('ORDER BY clause');
      let direction: 'ASC' | 'DESC' | undefined;

      if (this.cursor.currentType() === TokenType.ASC) {
        this.cursor.eat(TokenType.ASC);
        direction = 'ASC';
      } else if (this.cursor.currentType() === TokenType.DESC) {
        this.cursor.eat(TokenType.DESC);
        direction = 'DESC';
      }

      items.push({ column, direction: direction ?? 'ASC' });

      if (this.cursor.currentType() !== TokenType.COMMA) {
        break;
      }

      this.cursor.eat(TokenType.COMMA);
      if (this.cursor.currentType() !== TokenType.IDENTIFIER) {
        throw new Error(`Expected column name after COMMA but got ${this.cursor.currentType()}`);
      }
    }

    return { type: 'OrderByStatement', items };
  }

  /**
   * Parses LIMIT and optional OFFSET clause.
   * @returns {LimitOffsetNode} Limit/offset node.
   * @throws {Error} When LIMIT/OFFSET values are missing or invalid.
   * @example Parses "LIMIT 10 OFFSET 5" as { type: 'LimitOffset', limit: 10, offset: 5 }
   */
  private parseLimitOffset(): LimitOffsetNode {
    this.cursor.eat(TokenType.LIMIT);

    if (this.cursor.currentType() !== TokenType.NUMBER) {
      throw new Error(`Expected number after LIMIT but got ${this.cursor.currentType()}`);
    }

    const limit = parseInt(this.cursor.currentValue(), 10);
    this.cursor.eat(TokenType.NUMBER);

    let offset: number | undefined;

    if (this.cursor.currentType() === TokenType.OFFSET) {
      this.cursor.eat(TokenType.OFFSET);

      if (this.cursor.currentType() !== TokenType.NUMBER) {
        throw new Error(`Expected number after OFFSET but got ${this.cursor.currentType()}`);
      }

      offset = parseInt(this.cursor.currentValue(), 10);
      this.cursor.eat(TokenType.NUMBER);
    }

    return { type: 'LimitOffset', limit, offset };
  }

  /**
   * Parses a JOIN clause from SELECT FROM sources.
   * @grammar qualifiedJoin
   * @returns {JoinNode} Join node.
   * @throws {Error} When JOIN syntax is invalid.
   * @example Parses "LEFT JOIN orders ON users.id = orders.user_id" as { type: 'Join', joinType: 'LEFT', table: { type: 'Table', name: 'orders' }, on: { type: 'ComparisonExpression', left: { type: 'Identifier', name: 'users.id' }, operator: '=', right: { type: 'Identifier', name: 'orders.user_id' } } }
   */
  private parseJoin(): JoinNode {
    let joinType: 'CROSS' | 'INNER' | 'LEFT' | 'RIGHT' | 'OUTER' = 'INNER';

    switch (this.cursor.currentType()) {
      case TokenType.CROSS:
        this.cursor.eat(TokenType.CROSS);
        joinType = 'CROSS';
        break;
      case TokenType.INNER:
        this.cursor.eat(TokenType.INNER);
        joinType = 'INNER';
        break;
      case TokenType.LEFT:
        this.cursor.eat(TokenType.LEFT);
        joinType = 'LEFT';
        break;
      case TokenType.RIGHT:
        this.cursor.eat(TokenType.RIGHT);
        joinType = 'RIGHT';
        break;
      case TokenType.OUTER:
        this.cursor.eat(TokenType.OUTER);
        joinType = 'OUTER';
        break;
      default:
        break;
    }

    if (this.cursor.currentType() === TokenType.OUTER) {
      this.cursor.eat(TokenType.OUTER);
    }

    if (this.cursor.currentType() !== TokenType.JOIN) {
      throw new Error(`Expected JOIN after ${joinType} but got ${this.cursor.currentType()}`);
    }

    this.cursor.eat(TokenType.JOIN);

    if (this.cursor.currentType() !== TokenType.IDENTIFIER) {
      throw new Error(`Expected table name after JOIN but got ${this.cursor.currentType()}`);
    }

    const tableName = this.cursor.currentValue();
    this.cursor.eat(TokenType.IDENTIFIER);

    if (joinType === 'CROSS') {
      return {
        type: 'Join',
        table: { type: 'Table', name: tableName },
        joinType,
      };
    }

    if (this.cursor.currentType() !== TokenType.ON) {
      throw new Error(`Expected ON after JOIN but got ${this.cursor.currentType()}`);
    }

    this.cursor.eat(TokenType.ON);

    const left = this.valueParser.parseIdentifierNode('JOIN ON clause');
    const operator = this.valueParser.parseComparisonOperator();
    const right = this.valueParser.parseValueNode();

    return {
      type: 'Join',
      table: { type: 'Table', name: tableName },
      joinType,
      on: { type: 'ComparisonExpression', left, operator, right },
    };
  }
}
