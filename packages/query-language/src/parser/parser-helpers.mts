// @author Tijn Gommers
// @date 2026-04-06

import { TokenType } from '../types/index.mjs';
import type { AggregateFunctionName } from '../types/index.mjs';
import { ParserCursor } from './parser-cursor.mjs';

/**
 * Checks whether a token is a supported aggregate-function keyword.
 * @param tokenType Token type to inspect.
 * @returns {boolean} True when token is an aggregate-function keyword.
 */
export function isAggregateFunctionToken(tokenType: TokenType): boolean {
  return (
    tokenType === TokenType.COUNT ||
    tokenType === TokenType.SUM ||
    tokenType === TokenType.AVG ||
    tokenType === TokenType.MIN ||
    tokenType === TokenType.MAX
  );
}

/**
 * Parses an aggregate-function name from the current token.
 * @param cursor Shared parser cursor.
 * @param errorContext Context label used in parse errors.
 * @returns {AggregateFunctionName} Aggregate function name.
 * @throws {Error} When the current token is not a supported aggregate function.
 */
export function parseAggregateFunctionName(cursor: ParserCursor, errorContext: string): AggregateFunctionName {
  switch (cursor.currentType()) {
    case TokenType.COUNT:
      cursor.eat(TokenType.COUNT);
      return 'COUNT';
    case TokenType.SUM:
      cursor.eat(TokenType.SUM);
      return 'SUM';
    case TokenType.AVG:
      cursor.eat(TokenType.AVG);
      return 'AVG';
    case TokenType.MIN:
      cursor.eat(TokenType.MIN);
      return 'MIN';
    case TokenType.MAX:
      cursor.eat(TokenType.MAX);
      return 'MAX';
    default:
      throw new Error(`Unsupported function in ${errorContext}: ${cursor.currentValue()}`);
  }
}
