// @author Tijn Gommers
// @date 2026-03-30

import { TokenType } from '../types/index.mjs';
import type {
  AggregateFunctionNode,
  ArithmeticExpressionNode,
  ComparisonNode,
  ExpressionNode,
  IdentifierNode,
  InExpressionNode,
  NullCheckExpressionNode,
  ValueExpressionNode,
  ValueNode,
  WildcardNode,
} from '../types/index.mjs';
import { ParserCursor } from './parser-cursor.mjs';
import { isAggregateFunctionToken, parseAggregateFunctionName } from './parser-helpers.mjs';
import { ValueParser } from './value-parser.mjs';

/**
 * Parses boolean and arithmetic expressions for WHERE and HAVING clauses.
 * Grammar reference: ../../GRAMMAR.ebnf
 * @class ExpressionParser
 */
export class ExpressionParser {
  private cursor: ParserCursor;
  private valueParser: ValueParser;

  /**
   * Creates an expression parser.
   * @param cursor Shared parser cursor.
   * @param valueParser Value parser used for identifiers/literals/operators.
   */
  constructor(cursor: ParserCursor, valueParser: ValueParser) {
    this.cursor = cursor;
    this.valueParser = valueParser;
  }

  /**
   * Parses a WHERE expression.
   * @grammar expression
   * @returns {ExpressionNode} Parsed expression AST.
   * @throws {Error} When expression syntax is invalid.
   */
  parseWhereExpression(): ExpressionNode {
    return this.parseOrExpression(false);
  }

  /**
   * Parses a HAVING expression with aggregate-function support.
   * @grammar expressionWithAggregate
   * @returns {ExpressionNode} Parsed expression AST.
   * @throws {Error} When expression syntax is invalid.
   */
  parseHavingExpression(): ExpressionNode {
    return this.parseOrExpression(true);
  }

  /**
   * Parses OR-precedence expressions.
   * This is the expression entry point because OR has the lowest boolean precedence;
   * starting here ensures tighter operators (AND, NOT, comparisons, arithmetic) are parsed first.
   * @grammar orExpression
   * @param allowAggregateFunctions Whether aggregate functions are allowed in value expressions.
   * @returns {ExpressionNode} Parsed expression AST.
   * @example Parses "a = 5 OR b > 10 AND c IS NULL" as an OR expression with left child "a = 5" and right child "b > 10 AND c IS NULL"
   */
  private parseOrExpression(allowAggregateFunctions: boolean): ExpressionNode {
    let left = this.parseAndExpression(allowAggregateFunctions);

    while (this.cursor.currentType() === TokenType.OR) {
      this.cursor.eat(TokenType.OR);
      const right = this.parseAndExpression(allowAggregateFunctions);
      left = this.buildLogicalExpression('OR', left, right);
    }

    return left;
  }

  /**
   * Parses AND-precedence expressions.
   * @grammar andExpression
   * @param allowAggregateFunctions Whether aggregate functions are allowed in value expressions.
   * @returns {ExpressionNode} Parsed expression AST.
   */
  private parseAndExpression(allowAggregateFunctions: boolean): ExpressionNode {
    let left = this.parseUnaryExpression(allowAggregateFunctions);

    while (this.cursor.currentType() === TokenType.AND) {
      this.cursor.eat(TokenType.AND);
      const right = this.parseUnaryExpression(allowAggregateFunctions);
      left = this.buildLogicalExpression('AND', left, right);
    }

    return left;
  }

  /**
   * Parses unary expressions such as NOT or parenthesized expressions.
   * @grammar unaryExpression
   * @param allowAggregateFunctions Whether aggregate functions are allowed in value expressions.
   * @returns {ExpressionNode} Parsed expression AST.
   */
  private parseUnaryExpression(allowAggregateFunctions: boolean): ExpressionNode {
    if (this.cursor.currentType() === TokenType.NOT) {
      this.cursor.eat(TokenType.NOT);
      const expression = this.parseUnaryExpression(allowAggregateFunctions);
      return {
        type: 'NotExpression',
        operator: 'NOT',
        expression,
      };
    }

    if (this.cursor.currentType() === TokenType.LEFT_PAREN) {
      this.cursor.eat(TokenType.LEFT_PAREN);
      const expression = this.parseOrExpression(allowAggregateFunctions);
      this.cursor.eat(TokenType.RIGHT_PAREN);
      return expression;
    }

    return this.parseComparisonExpression(allowAggregateFunctions);
  }

  /**
   * Parses comparison, IN, and IS NULL expressions.
   * @grammar comparisonExpression
   * @param allowAggregateFunctions Whether aggregate functions are allowed in value expressions.
   * @returns {ComparisonNode | NullCheckExpressionNode | InExpressionNode} Comparison-compatible expression node.
   * @throws {Error} When operator or operand syntax is invalid.
   */
  private parseComparisonExpression(
    allowAggregateFunctions: boolean,
  ): ComparisonNode | NullCheckExpressionNode | InExpressionNode {
    const left = this.parseAdditiveExpression(allowAggregateFunctions);

    if (this.cursor.currentType() === TokenType.IN) {
      // example: "user.id IN (1, 2, 3)"
      if (left.type !== 'Identifier') {
        throw new Error('Expected identifier before IN operator');
      }

      this.cursor.eat(TokenType.IN);
      this.cursor.eat(TokenType.LEFT_PAREN);

      const values: ValueNode[] = [];
      while (this.cursor.currentType() !== TokenType.RIGHT_PAREN) {
        values.push(this.valueParser.parseValueNode());
        if (this.cursor.currentType() === TokenType.COMMA) {
          this.cursor.eat(TokenType.COMMA);
        }
      }

      this.cursor.eat(TokenType.RIGHT_PAREN);
      return {
        type: 'InExpression',
        left,
        values,
      };
    }

    if (this.cursor.currentType() === TokenType.IS) {
      // example: "user.name IS NOT NULL"
      if (left.type !== 'Identifier') {
        throw new Error('Expected identifier before IS operator');
      }

      this.cursor.eat(TokenType.IS);
      let isNegated = false;

      if (this.cursor.currentType() === TokenType.NOT) {
        this.cursor.eat(TokenType.NOT);
        isNegated = true;
      }

      if (this.cursor.currentType() !== TokenType.NULL) {
        throw new Error(`Expected NULL after IS (NOT) but got ${this.cursor.currentType()}`);
      }

      this.cursor.eat(TokenType.NULL);
      return {
        type: 'NullCheckExpression',
        left,
        isNegated,
      };
    }

    if (!this.isComparisonOperator(this.cursor.currentType())) {
      throw new Error(`Expected comparison operator but got ${this.cursor.currentType()}`);
    }

    const operator = this.valueParser.parseComparisonOperator();
    const right = this.parseAdditiveExpression(allowAggregateFunctions);

    return {
      type: 'ComparisonExpression',
      left,
      operator,
      right,
    };
  }

  /**
   * Parses additive arithmetic expressions.
   * @param allowAggregateFunctions Whether aggregate functions are allowed in value expressions.
   * @returns {ValueExpressionNode} Parsed value expression.
   */
  private parseAdditiveExpression(allowAggregateFunctions: boolean): ValueExpressionNode {
    let expression = this.parseMultiplicativeExpression(allowAggregateFunctions);

    while (this.cursor.currentType() === TokenType.PLUS || this.cursor.currentType() === TokenType.MINUS) {
      const operator = this.cursor.currentType() === TokenType.PLUS ? '+' : '-';
      this.cursor.eat(this.cursor.currentType());
      const right = this.parseMultiplicativeExpression(allowAggregateFunctions);
      expression = this.buildArithmeticExpression(expression, operator, right);
    }

    return expression;
  }

  /**
   * Parses multiplicative arithmetic expressions.
   * @param allowAggregateFunctions Whether aggregate functions are allowed in value expressions.
   * @returns {ValueExpressionNode} Parsed value expression.
   */
  private parseMultiplicativeExpression(allowAggregateFunctions: boolean): ValueExpressionNode {
    let expression = this.parseValuePrimaryExpression(allowAggregateFunctions);

    while (this.cursor.currentType() === TokenType.STAR || this.cursor.currentType() === TokenType.DIVIDE) {
      const operator = this.cursor.currentType() === TokenType.STAR ? '*' : '/';
      this.cursor.eat(this.cursor.currentType());
      const right = this.parseValuePrimaryExpression(allowAggregateFunctions);
      expression = this.buildArithmeticExpression(expression, operator, right);
    }

    return expression;
  }

  /**
   * Parses primary value expressions.
   * @param allowAggregateFunctions Whether aggregate functions are allowed in value expressions.
   * @returns {ValueExpressionNode} Parsed value expression.
   */
  private parseValuePrimaryExpression(allowAggregateFunctions: boolean): ValueExpressionNode {
    if (this.cursor.currentType() === TokenType.LEFT_PAREN) {
      this.cursor.eat(TokenType.LEFT_PAREN);
      const expression = this.parseAdditiveExpression(allowAggregateFunctions);
      this.cursor.eat(TokenType.RIGHT_PAREN);
      return expression;
    }

    if (allowAggregateFunctions && isAggregateFunctionToken(this.cursor.currentType())) {
      return this.parseAggregateFunctionValue();
    }

    return this.valueParser.parseValueNode();
  }

  /**
   * Parses aggregate function calls used in HAVING expressions.
   * @returns {AggregateFunctionNode} Aggregate-function AST node.
   * @throws {Error} When aggregate syntax is invalid.
   */
  private parseAggregateFunctionValue(): AggregateFunctionNode {
    const functionName = parseAggregateFunctionName(this.cursor, 'HAVING clause');
    this.cursor.eat(TokenType.LEFT_PAREN);

    let argument: IdentifierNode | WildcardNode;
    if (this.cursor.currentType() === TokenType.STAR) {
      if (functionName !== 'COUNT') {
        throw new Error('Only COUNT supports wildcard argument');
      }

      this.cursor.eat(TokenType.STAR);
      argument = { type: 'Wildcard', value: '*' };
    } else if (this.cursor.currentType() === TokenType.IDENTIFIER) {
      argument = this.valueParser.parseIdentifierNode('HAVING clause');
    } else {
      throw new Error(`Expected aggregate argument but got ${this.cursor.currentType()}`);
    }

    this.cursor.eat(TokenType.RIGHT_PAREN);
    return { type: 'AggregateFunction', functionName, argument };
  }

  /**
   * Builds a logical expression node.
   * @param operator Logical operator.
   * @param left Left operand.
   * @param right Right operand.
   * @returns {ExpressionNode} Logical expression node.
   */
  private buildLogicalExpression(operator: 'AND' | 'OR', left: ExpressionNode, right: ExpressionNode): ExpressionNode {
    return {
      type: 'LogicalExpression',
      operator,
      left,
      right,
    };
  }

  /**
   * Builds an arithmetic expression node.
   * @param left Left arithmetic operand.
   * @param operator Arithmetic operator.
   * @param right Right arithmetic operand.
   * @returns {ArithmeticExpressionNode} Arithmetic expression node.
   */
  private buildArithmeticExpression(
    left: ValueExpressionNode,
    operator: '+' | '-' | '*' | '/',
    right: ValueExpressionNode,
  ): ArithmeticExpressionNode {
    return {
      type: 'ArithmeticExpression',
      left,
      operator,
      right,
    };
  }

  /**
   * Checks whether a token is a comparison operator token.
   * @param tokenType Token type to inspect.
   * @returns {boolean} True when token is a comparison operator.
   */
  private isComparisonOperator(tokenType: TokenType): boolean {
    return (
      tokenType === TokenType.EQUALS ||
      tokenType === TokenType.GREATER_THAN ||
      tokenType === TokenType.LESS_THAN ||
      tokenType === TokenType.GREATER_THAN_OR_EQUALS ||
      tokenType === TokenType.LESS_THAN_OR_EQUALS ||
      tokenType === TokenType.NOT_EQUALS
    );
  }
}
