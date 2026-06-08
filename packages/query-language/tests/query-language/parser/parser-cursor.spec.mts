//@author Tijn Gommers
//@date 2026-04-14

import { describe, expect, it } from 'vitest';
import { Lexer } from '../../../src/lexer/lexer.mjs';
import { ParserCursor } from '../../../src/parser/parser-cursor.mjs';
import { TokenType } from '../../../src/types/index.mjs';

describe('ParserCursor', () => {
  it('should advance when eat receives the expected token', () => {
    const cursor = new ParserCursor(new Lexer('SELECT'));

    expect(cursor.currentType()).toBe(TokenType.SELECT);

    cursor.eat(TokenType.SELECT);

    expect(cursor.currentType()).toBe(TokenType.EOF);
  });

  it('should expose the current token through current()', () => {
    const cursor = new ParserCursor(new Lexer("'Alice'"));

    expect(cursor.current()).toEqual({ type: TokenType.STRING, value: 'Alice' });
    expect(cursor.currentType()).toBe(TokenType.STRING);
    expect(cursor.currentValue()).toBe('Alice');
  });

  it('should throw when eat receives the wrong token type', () => {
    const cursor = new ParserCursor(new Lexer('SELECT'));

    expect(() => cursor.eat(TokenType.FROM)).toThrow('Expected token FROM but got SELECT');
  });
});
