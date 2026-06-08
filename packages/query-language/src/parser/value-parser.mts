// @author Tijn Gommers
// @date 2026-03-30

import { TokenType } from '../types/index.mjs';
import type { ComparisonOperator, IdentifierNode, LiteralNode } from '../types/index.mjs';
import { ParserCursor } from './parser-cursor.mjs';

/**
 * Parses identifiers, literals, and comparison operators from parser tokens.
 * @class ValueParser
 */
export class ValueParser {
  private cursor: ParserCursor;

  /**
   * Creates a value parser bound to a parser cursor.
   * @param cursor Shared parser cursor instance.
   */
  constructor(cursor: ParserCursor) {
    this.cursor = cursor;
  }

  /**
   * Parses a comparison operator token.
   * @returns {ComparisonOperator} Comparison operator string.
   * @throws {Error} When the current token is not a comparison operator.
   */
  parseComparisonOperator(): ComparisonOperator {
    switch (this.cursor.currentType()) {
      case TokenType.EQUALS:
        this.cursor.eat(TokenType.EQUALS);
        return '=';
      case TokenType.GREATER_THAN:
        this.cursor.eat(TokenType.GREATER_THAN);
        return '>';
      case TokenType.LESS_THAN:
        this.cursor.eat(TokenType.LESS_THAN);
        return '<';
      case TokenType.GREATER_THAN_OR_EQUALS:
        this.cursor.eat(TokenType.GREATER_THAN_OR_EQUALS);
        return '>=';
      case TokenType.LESS_THAN_OR_EQUALS:
        this.cursor.eat(TokenType.LESS_THAN_OR_EQUALS);
        return '<=';
      case TokenType.NOT_EQUALS:
        this.cursor.eat(TokenType.NOT_EQUALS);
        return '!=';
      default:
        throw new Error(`Expected comparison operator but got ${this.cursor.currentType()}`);
    }
  }

  /**
   * Parses a literal or identifier value node.
   * @returns {IdentifierNode | LiteralNode} Identifier or literal value node.
   * @throws {Error} When the current token cannot be interpreted as a value.
   */
  parseValueNode(): IdentifierNode | LiteralNode {
    const tokenType = this.cursor.currentType();
    const tokenValue = this.cursor.currentValue();

    if (tokenType === TokenType.NUMBER) {
      this.cursor.eat(TokenType.NUMBER);
      return {
        type: 'Literal',
        valueType: 'number',
        value: Number(tokenValue),
      };
    }

    if (tokenType === TokenType.STRING) {
      this.cursor.eat(TokenType.STRING);
      return {
        type: 'Literal',
        valueType: 'string',
        value: tokenValue,
      };
    }

    if (tokenType === TokenType.IDENTIFIER) {
      return this.parseIdentifierNode('WHERE clause');
    }

    if (tokenType === TokenType.NULL) {
      this.cursor.eat(TokenType.NULL);
      return {
        type: 'Literal',
        valueType: 'null',
        value: null,
      };
    }

    throw new Error(`Expected value in WHERE clause but got ${tokenType}`);
  }

  /**
   * Parses an identifier node, including dotted paths.
   * @param errorContext Context label used in parse errors.
   * @returns {IdentifierNode} Identifier node.
   * @throws {Error} When identifier syntax is invalid.
   * @example Parses "user.name" as an identifier node with name "user.name"
   */
  parseIdentifierNode(errorContext: string = 'WHERE clause'): IdentifierNode {
    if (this.cursor.currentType() !== TokenType.IDENTIFIER) {
      throw new Error(`Expected identifier in ${errorContext} but got ${this.cursor.currentType()}`);
    }

    let name = this.cursor.currentValue();
    this.cursor.eat(TokenType.IDENTIFIER);

    while (this.cursor.currentType() === TokenType.DOT) {
      this.cursor.eat(TokenType.DOT);
      if (this.cursor.currentType() !== TokenType.IDENTIFIER) {
        throw new Error(`Expected identifier after dot but got ${this.cursor.currentType()}`);
      }

      name = `${name}.${this.cursor.currentValue()}`;
      this.cursor.eat(TokenType.IDENTIFIER);
    }

    return {
      type: 'Identifier',
      name,
    };
  }
}
