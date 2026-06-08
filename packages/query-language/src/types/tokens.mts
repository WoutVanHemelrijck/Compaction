// @author Tijn Gommers
// @date 2026-03-30

/**
 * Token types emitted by the lexer and consumed by the parser.
 * @enum {string}
 */
export enum TokenType {
  SELECT = 'SELECT',
  DELETE = 'DELETE',
  FROM = 'FROM',
  WHERE = 'WHERE',
  AND = 'AND',
  OR = 'OR',
  IDENTIFIER = 'IDENTIFIER',
  NUMBER = 'NUMBER',
  EQUALS = 'EQUALS',
  GREATER_THAN = 'GREATER_THAN',
  GREATER_THAN_OR_EQUALS = 'GREATER_THAN_OR_EQUALS',
  LESS_THAN = 'LESS_THAN',
  LESS_THAN_OR_EQUALS = 'LESS_THAN_OR_EQUALS',
  EOF = 'EOF',
  STRING = 'STRING',
  COMMA = 'COMMA',
  STAR = 'STAR',
  NOT = 'NOT',
  NOT_EQUALS = 'NOT_EQUALS',
  IS = 'IS',
  NULL = 'NULL',
  ORDER = 'ORDER',
  BY = 'BY',
  ASC = 'ASC',
  DESC = 'DESC',
  CROSS = 'CROSS',
  JOIN = 'JOIN',
  ON = 'ON',
  DOT = 'DOT',
  INNER = 'INNER',
  LEFT = 'LEFT',
  RIGHT = 'RIGHT',
  OUTER = 'OUTER',
  LIMIT = 'LIMIT',
  OFFSET = 'OFFSET',
  DISTINCT = 'DISTINCT',
  IN = 'IN',
  COUNT = 'COUNT',
  SUM = 'SUM',
  AVG = 'AVG',
  MIN = 'MIN',
  MAX = 'MAX',
  LEFT_PAREN = 'LEFT_PAREN',
  RIGHT_PAREN = 'RIGHT_PAREN',
  PLUS = 'PLUS',
  MINUS = 'MINUS',
  DIVIDE = 'DIVIDE',
  GROUP = 'GROUP',
  HAVING = 'HAVING',
  INSERT = 'INSERT',
  INTO = 'INTO',
  VALUES = 'VALUES',
  UPDATE = 'UPDATE',
  SET = 'SET',
}

/**
 * Single lexical token emitted by the lexer.
 * @interface Token
 * @property {TokenType} type Token classification.
 * @property {string} value Raw token value.
 */
export interface Token {
  type: TokenType;
  value: string;
}
