// @author Tijn Gommers
// @date 2026-03-30

import { TokenType } from '../types/index.mjs';
import type { Token } from '../types/index.mjs';

/**
 * Converts query-language input text into a stream of tokens.
 * @class Lexer
 */
export class Lexer {
  private input: string;
  private cursor: number = 0;

  /**
   * Creates a lexer for a query string.
   * @param input Raw query-language source text.
   */
  constructor(input: string) {
    this.input = input;
  }

  /**
   * Reads the next token from the current cursor position.
   * @returns {Token} The next token in the input stream.
   * @throws {Error} When an unexpected character is encountered.
   */
  public nextToken(): Token {
    this.skipWhitespace();

    if (this.cursor >= this.input.length) {
      return { type: TokenType.EOF, value: '' };
    }

    const char = this.input[this.cursor];

    if (/\d/.test(char)) {
      return this.readNumber();
    }

    if (char === "'") {
      return this.readString();
    }

    if (/[a-zA-Z_]/.test(char)) {
      return this.readIdentifier();
    }

    const operatorToken = this.checkOperators();
    if (operatorToken) {
      return operatorToken;
    }

    throw new Error(`Unexpected character: ${char}`);
  }

  /**
   * Advances the cursor past contiguous whitespace.
   * @returns {void}
   */
  private skipWhitespace(): void {
    while (this.cursor < this.input.length && /\s/.test(this.input[this.cursor])) {
      this.cursor++;
    }
  }

  /**
   * Resolves an identifier value as a keyword token when applicable.
   * @param id Upper-cased identifier text.
   * @returns {Token} Keyword token or a generic identifier token.
   */
  private checkIdentifierOrKeyword(id: string): Token {
    switch (id) {
      case 'SELECT':
        return { type: TokenType.SELECT, value: id };
      case 'DELETE':
        return { type: TokenType.DELETE, value: id };
      case 'FROM':
        return { type: TokenType.FROM, value: id };
      case 'WHERE':
        return { type: TokenType.WHERE, value: id };
      case 'AND':
        return { type: TokenType.AND, value: id };
      case 'OR':
        return { type: TokenType.OR, value: id };
      case 'NOT':
        return { type: TokenType.NOT, value: id };
      case 'NULL':
        return { type: TokenType.NULL, value: id };
      case 'IS':
        return { type: TokenType.IS, value: id };
      case 'ORDER':
        return { type: TokenType.ORDER, value: id };
      case 'BY':
        return { type: TokenType.BY, value: id };
      case 'ASC':
        return { type: TokenType.ASC, value: id };
      case 'DESC':
        return { type: TokenType.DESC, value: id };
      case 'CROSS':
        return { type: TokenType.CROSS, value: id };
      case 'JOIN':
        return { type: TokenType.JOIN, value: id };
      case 'ON':
        return { type: TokenType.ON, value: id };
      case 'INNER':
        return { type: TokenType.INNER, value: id };
      case 'LEFT':
        return { type: TokenType.LEFT, value: id };
      case 'RIGHT':
        return { type: TokenType.RIGHT, value: id };
      case 'OUTER':
        return { type: TokenType.OUTER, value: id };
      case 'LIMIT':
        return { type: TokenType.LIMIT, value: id };
      case 'OFFSET':
        return { type: TokenType.OFFSET, value: id };
      case 'DISTINCT':
        return { type: TokenType.DISTINCT, value: id };
      case 'IN':
        return { type: TokenType.IN, value: id };
      case 'COUNT':
        return { type: TokenType.COUNT, value: id };
      case 'SUM':
        return { type: TokenType.SUM, value: id };
      case 'AVG':
        return { type: TokenType.AVG, value: id };
      case 'MIN':
        return { type: TokenType.MIN, value: id };
      case 'MAX':
        return { type: TokenType.MAX, value: id };
      case 'HAVING':
        return { type: TokenType.HAVING, value: id };
      case 'GROUP':
        return { type: TokenType.GROUP, value: id };
      case 'INSERT':
        return { type: TokenType.INSERT, value: id };
      case 'INTO':
        return { type: TokenType.INTO, value: id };
      case 'VALUES':
        return { type: TokenType.VALUES, value: id };
      case 'UPDATE':
        return { type: TokenType.UPDATE, value: id };
      case 'SET':
        return { type: TokenType.SET, value: id };
      default:
        return { type: TokenType.IDENTIFIER, value: id };
    }
  }

  /**
   * Reads a numeric literal token from the current cursor.
   * @returns {Token} NUMBER token with the parsed numeric string.
   */
  private readNumber(): Token {
    let num = '';
    while (this.cursor < this.input.length && /\d/.test(this.input[this.cursor])) {
      num += this.input[this.cursor];
      this.cursor++;
    }
    return { type: TokenType.NUMBER, value: num };
  }

  /**
   * Reads an identifier or keyword token from the current cursor.
   * @returns {Token} Identifier or keyword token.
   */
  private readIdentifier(): Token {
    let id = '';
    while (this.cursor < this.input.length && /[a-zA-Z0-9_]/.test(this.input[this.cursor])) {
      id += this.input[this.cursor];
      this.cursor++;
    }
    return this.checkIdentifierOrKeyword(id.toUpperCase());
  }

  /**
   * Reads punctuation or operator tokens from the current cursor.
   * @returns {Token | null} Operator token when a known operator exists, otherwise null.
   */
  private checkOperators(): Token | null {
    const twoChars = this.input.slice(this.cursor, this.cursor + 2);
    switch (twoChars) {
      case '<=':
        this.cursor += 2;
        return { type: TokenType.LESS_THAN_OR_EQUALS, value: '<=' };
      case '>=':
        this.cursor += 2;
        return { type: TokenType.GREATER_THAN_OR_EQUALS, value: '>=' };
      case '!=':
        this.cursor += 2;
        return { type: TokenType.NOT_EQUALS, value: '!=' };
    }

    const char = this.input[this.cursor];
    switch (char) {
      case ',':
        this.cursor++;
        return { type: TokenType.COMMA, value: ',' };
      case '*':
        this.cursor++;
        return { type: TokenType.STAR, value: '*' };
      case '=':
        this.cursor++;
        return { type: TokenType.EQUALS, value: '=' };
      case '>':
        this.cursor++;
        return { type: TokenType.GREATER_THAN, value: '>' };
      case '<':
        this.cursor++;
        return { type: TokenType.LESS_THAN, value: '<' };
      case '.':
        this.cursor++;
        return { type: TokenType.DOT, value: '.' };
      case '(':
        this.cursor++;
        return { type: TokenType.LEFT_PAREN, value: '(' };
      case ')':
        this.cursor++;
        return { type: TokenType.RIGHT_PAREN, value: ')' };
      case '+':
        this.cursor++;
        return { type: TokenType.PLUS, value: '+' };
      case '-':
        this.cursor++;
        return { type: TokenType.MINUS, value: '-' };
      case '/':
        this.cursor++;
        return { type: TokenType.DIVIDE, value: '/' };
      default:
        return null;
    }
  }

  /**
   * Reads a single-quoted string literal token.
   * @returns {Token} STRING token with unquoted string value.
   * @throws {Error} When the string literal is unterminated.
   */
  private readString(): Token {
    let str = '';
    this.cursor++;
    while (this.cursor < this.input.length && this.input[this.cursor] !== "'") {
      str += this.input[this.cursor];
      this.cursor++;
    }
    if (this.cursor >= this.input.length) {
      throw new Error('Unterminated string literal');
    }
    this.cursor++;
    return { type: TokenType.STRING, value: str };
  }
}
