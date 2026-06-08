// @author Tijn Gommers
// @date 2026-03-30

import { Lexer } from '../lexer/lexer.mjs';
import { TokenType } from '../types/index.mjs';
import type { Token } from '../types/index.mjs';

/**
 * Maintains parser position and provides token navigation helpers.
 * @class ParserCursor
 */
export class ParserCursor {
  private lexer: Lexer;
  private currentToken: Token;

  /**
   * Creates a parser cursor initialized with the first lexer token.
   * @param lexer Lexer instance that provides tokens.
   */
  constructor(lexer: Lexer) {
    this.lexer = lexer;
    this.currentToken = this.lexer.nextToken();
  }

  /**
   * Gets the current token type.
   * @returns {TokenType} Current token type.
   */
  currentType(): TokenType {
    return this.currentToken.type;
  }

  /**
   * Gets the current token value.
   * @returns {string} Current token value.
   */
  currentValue(): string {
    return this.currentToken.value;
  }

  /**
   * Gets the full current token object.
   * @returns {Token} Current token.
   */
  current(): Token {
    return this.currentToken;
  }

  /**
   * Consumes the current token when it matches the expected type.
   * @param tokenType Token type that must match the current token.
   * @returns {void}
   * @throws {Error} When the current token does not match the expected type.
   */
  eat(tokenType: TokenType): void {
    if (this.currentToken.type !== tokenType) {
      throw new Error(`Expected token ${tokenType} but got ${this.currentToken.type}`);
    }

    this.currentToken = this.lexer.nextToken();
  }
}
