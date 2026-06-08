//@author Tijn Gommers
//@date 2026-04-14

import { describe, expect, it } from 'vitest';
import { Lexer } from '../../../src/lexer/lexer.mjs';
import { ParserCursor } from '../../../src/parser/parser-cursor.mjs';
import { ValueParser } from '../../../src/parser/value-parser.mjs';

describe('ValueParser', () => {
  it('should throw when parsing a comparison operator from a non-operator token', () => {
    const parser = new ValueParser(new ParserCursor(new Lexer('SELECT')));

    expect(() => parser.parseComparisonOperator()).toThrow('Expected comparison operator but got SELECT');
  });

  it('should throw when parsing a value from an invalid token', () => {
    const parser = new ValueParser(new ParserCursor(new Lexer('SELECT')));

    expect(() => parser.parseValueNode()).toThrow('Expected value in WHERE clause but got SELECT');
  });

  it('should throw when parsing an identifier from a non-identifier token', () => {
    const parser = new ValueParser(new ParserCursor(new Lexer('SELECT')));

    expect(() => parser.parseIdentifierNode('test context')).toThrow(
      'Expected identifier in test context but got SELECT',
    );
  });
});
