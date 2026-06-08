//@author Tijn Gommers
// @date 2026-03-24

import { Parser } from '../../src/parser/parser.mjs';
import { Lexer } from '../../src/lexer/lexer.mjs';
import { describe, it, expect } from 'vitest';
import type { ASTNode, InsertStatement, SelectStatement } from '../../src/types/ast-operations.mjs';

function asSelectStatement(ast: ASTNode): SelectStatement {
  if (ast.type !== 'SelectStatement') {
    throw new Error(`Expected SelectStatement but got ${ast.type}`);
  }

  return ast;
}

function asInsertStatement(ast: ASTNode): InsertStatement {
  if (ast.type !== 'InsertStatement') {
    throw new Error(`Expected InsertStatement but got ${ast.type}`);
  }

  return ast;
}

describe('Parser', () => {
  it('should parse a simple SELECT statement without WHERE clause', () => {
    const lexer = new Lexer('SELECT name FROM users');
    const parser = new Parser(lexer);
    const ast = parser.parse();
    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    });
  });

  it('should parse a SELECT statement with a WHERE clause', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE id = 10');
    const parser = new Parser(lexer);
    const ast = parser.parse();
    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ID' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 10 },
      },
      orderBy: undefined,
      limit: undefined,
    });
  });

  it('should parse multiple columns separated by commas', () => {
    const lexer = new Lexer('SELECT name, age FROM users');
    const parser = new Parser(lexer);
    const ast = parser.parse();
    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [
        { type: 'Identifier', name: 'NAME' },
        { type: 'Identifier', name: 'AGE' },
      ],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    });
  });

  it('should parse SELECT * as all columns', () => {
    const lexer = new Lexer('SELECT * FROM users');
    const parser = new Parser(lexer);
    const ast = parser.parse();
    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: '*' }],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    });
  });

  it('should parse a SELECT statement with >= in WHERE clause', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE age >= 18');
    const parser = new Parser(lexer);
    const ast = parser.parse();
    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'AGE' },
        operator: '>=',
        right: { type: 'Literal', valueType: 'number', value: 18 },
      },
      orderBy: undefined,
      limit: undefined,
    });
  });

  it('should parse a SELECT statement with != in WHERE clause', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE age != 18');
    const parser = new Parser(lexer);
    const ast = parser.parse();
    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'AGE' },
        operator: '!=',
        right: { type: 'Literal', valueType: 'number', value: 18 },
      },
      orderBy: undefined,
      limit: undefined,
    });
  });

  it('should parse a DELETE statement without WHERE clause', () => {
    const lexer = new Lexer('DELETE FROM users');
    const parser = new Parser(lexer);
    const ast = parser.parse();
    expect(ast).toEqual({
      type: 'DeleteStatement',
      from: [{ type: 'Table', name: 'USERS' }],
      where: undefined,
    });
  });

  it('should parse a DELETE statement with a WHERE clause', () => {
    const lexer = new Lexer('DELETE FROM users WHERE age > 20');
    const parser = new Parser(lexer);
    const ast = parser.parse();
    expect(ast).toEqual({
      type: 'DeleteStatement',
      from: [{ type: 'Table', name: 'USERS' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'AGE' },
        operator: '>',
        right: { type: 'Literal', valueType: 'number', value: 20 },
      },
    });
  });

  it('should parse a where clause with a string value', () => {
    const lexer = new Lexer("SELECT name FROM users WHERE city = 'New York'");
    const parser = new Parser(lexer);
    const ast = parser.parse();
    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'CITY' },
        operator: '=',
        right: { type: 'Literal', valueType: 'string', value: 'New York' },
      },
    });
  });

  it('should parse a where clause with an identifier as right operand', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE city = hometown');
    const parser = new Parser(lexer);
    const ast = parser.parse();
    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'CITY' },
        operator: '=',
        right: { type: 'Identifier', name: 'HOMETOWN' },
      },
    });
  });

  it('should parse a where clause with AND', () => {
    const lexer = new Lexer("SELECT name FROM users WHERE age >= 18 AND city = 'AMS'");
    const parser = new Parser(lexer);
    const ast = parser.parse();
    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'LogicalExpression',
        operator: 'AND',
        left: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'AGE' },
          operator: '>=',
          right: { type: 'Literal', valueType: 'number', value: 18 },
        },
        right: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'CITY' },
          operator: '=',
          right: { type: 'Literal', valueType: 'string', value: 'AMS' },
        },
      },
    });
  });

  it('should respect AND precedence over OR in WHERE clause', () => {
    const lexer = new Lexer("SELECT name FROM users WHERE age > 18 OR city = 'AMS' AND status = 'active'");
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'LogicalExpression',
        operator: 'OR',
        left: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'AGE' },
          operator: '>',
          right: { type: 'Literal', valueType: 'number', value: 18 },
        },
        right: {
          type: 'LogicalExpression',
          operator: 'AND',
          left: {
            type: 'ComparisonExpression',
            left: { type: 'Identifier', name: 'CITY' },
            operator: '=',
            right: { type: 'Literal', valueType: 'string', value: 'AMS' },
          },
          right: {
            type: 'ComparisonExpression',
            left: { type: 'Identifier', name: 'STATUS' },
            operator: '=',
            right: { type: 'Literal', valueType: 'string', value: 'active' },
          },
        },
      },
    });
  });

  it('should parse parenthesized group on the left side of OR', () => {
    const lexer = new Lexer("SELECT name FROM users WHERE (age > 18 AND city = 'AMS') OR status = 'active'");
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'LogicalExpression',
        operator: 'OR',
        left: {
          type: 'LogicalExpression',
          operator: 'AND',
          left: {
            type: 'ComparisonExpression',
            left: { type: 'Identifier', name: 'AGE' },
            operator: '>',
            right: { type: 'Literal', valueType: 'number', value: 18 },
          },
          right: {
            type: 'ComparisonExpression',
            left: { type: 'Identifier', name: 'CITY' },
            operator: '=',
            right: { type: 'Literal', valueType: 'string', value: 'AMS' },
          },
        },
        right: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'STATUS' },
          operator: '=',
          right: { type: 'Literal', valueType: 'string', value: 'active' },
        },
      },
    });
  });

  it('should parse parenthesized group on the right side of AND', () => {
    const lexer = new Lexer("SELECT name FROM users WHERE age > 18 AND (city = 'AMS' OR status = 'active')");
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'LogicalExpression',
        operator: 'AND',
        left: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'AGE' },
          operator: '>',
          right: { type: 'Literal', valueType: 'number', value: 18 },
        },
        right: {
          type: 'LogicalExpression',
          operator: 'OR',
          left: {
            type: 'ComparisonExpression',
            left: { type: 'Identifier', name: 'CITY' },
            operator: '=',
            right: { type: 'Literal', valueType: 'string', value: 'AMS' },
          },
          right: {
            type: 'ComparisonExpression',
            left: { type: 'Identifier', name: 'STATUS' },
            operator: '=',
            right: { type: 'Literal', valueType: 'string', value: 'active' },
          },
        },
      },
    });
  });

  it('should parse arithmetic precedence in comparison expressions', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE age + 2 * score > 100');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'ComparisonExpression',
        left: {
          type: 'ArithmeticExpression',
          operator: '+',
          left: { type: 'Identifier', name: 'AGE' },
          right: {
            type: 'ArithmeticExpression',
            operator: '*',
            left: { type: 'Literal', valueType: 'number', value: 2 },
            right: { type: 'Identifier', name: 'SCORE' },
          },
        },
        operator: '>',
        right: { type: 'Literal', valueType: 'number', value: 100 },
      },
    });
  });

  it('should parse parenthesized arithmetic expression in comparison', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE age * (score + 2) > 100');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'ComparisonExpression',
        left: {
          type: 'ArithmeticExpression',
          operator: '*',
          left: { type: 'Identifier', name: 'AGE' },
          right: {
            type: 'ArithmeticExpression',
            operator: '+',
            left: { type: 'Identifier', name: 'SCORE' },
            right: { type: 'Literal', valueType: 'number', value: 2 },
          },
        },
        operator: '>',
        right: { type: 'Literal', valueType: 'number', value: 100 },
      },
    });
  });

  it('should parse a where clause with NOT', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE NOT age = 18');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'NotExpression',
        operator: 'NOT',
        expression: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'AGE' },
          operator: '=',
          right: { type: 'Literal', valueType: 'number', value: 18 },
        },
      },
    });
  });

  it('should parse chained NOT expressions', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE NOT NOT age = 18');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'NotExpression',
        operator: 'NOT',
        expression: {
          type: 'NotExpression',
          operator: 'NOT',
          expression: {
            type: 'ComparisonExpression',
            left: { type: 'Identifier', name: 'AGE' },
            operator: '=',
            right: { type: 'Literal', valueType: 'number', value: 18 },
          },
        },
      },
    });
  });

  it('should parse NOT on the right side of AND', () => {
    const lexer = new Lexer("SELECT name FROM users WHERE age = 18 AND NOT city = 'AMS'");
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'LogicalExpression',
        operator: 'AND',
        left: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'AGE' },
          operator: '=',
          right: { type: 'Literal', valueType: 'number', value: 18 },
        },
        right: {
          type: 'NotExpression',
          operator: 'NOT',
          expression: {
            type: 'ComparisonExpression',
            left: { type: 'Identifier', name: 'CITY' },
            operator: '=',
            right: { type: 'Literal', valueType: 'string', value: 'AMS' },
          },
        },
      },
    });
  });

  it('should parse a where clause with != and AND', () => {
    const lexer = new Lexer("SELECT name FROM users WHERE age != 18 AND city = 'AMS'");
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'LogicalExpression',
        operator: 'AND',
        left: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'AGE' },
          operator: '!=',
          right: { type: 'Literal', valueType: 'number', value: 18 },
        },
        right: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'CITY' },
          operator: '=',
          right: { type: 'Literal', valueType: 'string', value: 'AMS' },
        },
      },
    });
  });

  it('should parse a where clause with IS NULL', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE city IS NULL');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'NullCheckExpression',
        left: { type: 'Identifier', name: 'CITY' },
        isNegated: false,
      },
    });
  });

  it('should parse a where clause with IS NOT NULL', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE city IS NOT NULL');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'NullCheckExpression',
        left: { type: 'Identifier', name: 'CITY' },
        isNegated: true,
      },
    });
  });

  it('should throw an error for invalid syntax', () => {
    const lexer = new Lexer('SELECT name users');
    const parser = new Parser(lexer);
    expect(() => parser.parse()).toThrow('Expected token FROM but got IDENTIFIER');
  });

  it('should throw when SELECT has no columns', () => {
    const lexer = new Lexer('SELECT FROM users');
    const parser = new Parser(lexer);
    expect(() => parser.parse()).toThrow('Expected at least one column after SELECT but got FROM');
  });

  it('should throw an error for trailing comma in select list', () => {
    const lexer = new Lexer('SELECT name, FROM users');
    const parser = new Parser(lexer);
    expect(() => parser.parse()).toThrow('Expected column name after COMMA but got FROM');
  });

  it('should throw an error for unexpected token in WHERE clause', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE id =');
    const parser = new Parser(lexer);
    expect(() => parser.parse()).toThrow('Expected value in WHERE clause but got EOF');
  });

  it('should throw when parenthesized WHERE expression is not closed', () => {
    const lexer = new Lexer("SELECT name FROM users WHERE (age > 18 AND city = 'AMS'");
    const parser = new Parser(lexer);
    expect(() => parser.parse()).toThrow('Expected token RIGHT_PAREN but got EOF');
  });

  it('should throw when IS is not followed by NULL', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE city IS 10');
    const parser = new Parser(lexer);
    expect(() => parser.parse()).toThrow('Expected NULL after IS (NOT) but got NUMBER');
  });

  it('should parse a WHERE clause that compares numeric literals', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE 10 = 20');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Literal', valueType: 'number', value: 10 },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 20 },
      },
    });
  });

  it('should throw an error for unexpected comparison operator token', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE id NULL');
    const parser = new Parser(lexer);
    expect(() => parser.parse()).toThrow('Expected comparison operator but got NULL');
  });

  it('should parse a comparison with NULL as right operand', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE city = NULL');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'CITY' },
        operator: '=',
        right: { type: 'Literal', valueType: 'null', value: null },
      },
    });
  });

  it('Should throw an error for unexpected first token', () => {
    const lexer = new Lexer("RANDOM users SET name = 'John' WHERE id = 1");
    const parser = new Parser(lexer);
    expect(() => parser.parse()).toThrow('Unexpected token: IDENTIFIER');
  });

  it('should correctly parse a < operator in WHERE clause', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE age < 30');
    const parser = new Parser(lexer);
    const ast = parser.parse();
    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'AGE' },
        operator: '<',
        right: { type: 'Literal', valueType: 'number', value: 30 },
      },
    });
  });

  it('should correctly parse a <= operator in WHERE clause', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE age <= 65');
    const parser = new Parser(lexer);
    const ast = parser.parse();
    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'AGE' },
        operator: '<=',
        right: { type: 'Literal', valueType: 'number', value: 65 },
      },
    });
  });

  it('should parse ORDER BY with multiple columns', () => {
    const lexer = new Lexer('SELECT name FROM users ORDER BY age, city DESC');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: undefined,
      orderBy: {
        type: 'OrderByStatement',
        items: [
          { column: { type: 'Identifier', name: 'AGE' }, direction: 'ASC' },
          { column: { type: 'Identifier', name: 'CITY' }, direction: 'DESC' },
        ],
      },
    });
  });

  it('should parse ORDER BY with ASC directly after the first column', () => {
    const lexer = new Lexer('SELECT name FROM users ORDER BY age ASC, city');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: undefined,
      orderBy: {
        type: 'OrderByStatement',
        items: [
          { column: { type: 'Identifier', name: 'AGE' }, direction: 'ASC' },
          { column: { type: 'Identifier', name: 'CITY' }, direction: 'ASC' },
        ],
      },
    });
  });

  it('should parse ORDER BY with ASC after the full column list', () => {
    const lexer = new Lexer('SELECT name FROM users ORDER BY age, city ASC');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: undefined,
      orderBy: {
        type: 'OrderByStatement',
        items: [
          { column: { type: 'Identifier', name: 'AGE' }, direction: 'ASC' },
          { column: { type: 'Identifier', name: 'CITY' }, direction: 'ASC' },
        ],
      },
    });
  });

  it('should default ORDER BY direction to ASC when omitted', () => {
    const lexer = new Lexer('SELECT name FROM users ORDER BY age, city');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: undefined,
      orderBy: {
        type: 'OrderByStatement',
        items: [
          { column: { type: 'Identifier', name: 'AGE' }, direction: 'ASC' },
          { column: { type: 'Identifier', name: 'CITY' }, direction: 'ASC' },
        ],
      },
    });
  });

  it('should parse SELECT with WHERE and ORDER BY', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE age >= 18 ORDER BY age DESC, city');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'NAME' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'AGE' },
        operator: '>=',
        right: { type: 'Literal', valueType: 'number', value: 18 },
      },
      orderBy: {
        type: 'OrderByStatement',
        items: [
          { column: { type: 'Identifier', name: 'AGE' }, direction: 'DESC' },
          { column: { type: 'Identifier', name: 'CITY' }, direction: 'ASC' },
        ],
      },
    });
  });

  it('should throw when ORDER BY has no columns', () => {
    const lexer = new Lexer('SELECT name FROM users ORDER BY');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected at least one column after ORDER BY but got EOF');
  });

  it('should throw when ORDER BY has trailing comma', () => {
    const lexer = new Lexer('SELECT name FROM users ORDER BY age,');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected column name after COMMA but got EOF');
  });

  it('should parse CROSS JOIN with two tables', () => {
    const lexer = new Lexer('SELECT * FROM users CROSS JOIN orders');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [
        { type: 'Table', name: 'USERS' },
        {
          type: 'Join',
          table: { type: 'Table', name: 'ORDERS' },
          joinType: 'CROSS',
        },
      ],
      columns: [{ type: 'Identifier', name: '*' }],
      where: undefined,
      orderBy: undefined,
    });
  });

  it('should parse comma-separated tables', () => {
    const lexer = new Lexer('SELECT * FROM users, orders, products');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [
        { type: 'Table', name: 'USERS' },
        { type: 'Table', name: 'ORDERS' },
        { type: 'Table', name: 'PRODUCTS' },
      ],
      columns: [{ type: 'Identifier', name: '*' }],
      where: undefined,
      orderBy: undefined,
    });
  });

  it('should parse multiple CROSS JOINs', () => {
    const lexer = new Lexer('SELECT * FROM users CROSS JOIN orders CROSS JOIN products');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.from).toEqual([
      { type: 'Table', name: 'USERS' },
      {
        type: 'Join',
        table: { type: 'Table', name: 'ORDERS' },
        joinType: 'CROSS',
      },
      {
        type: 'Join',
        table: { type: 'Table', name: 'PRODUCTS' },
        joinType: 'CROSS',
      },
    ]);
  });

  it('should throw error for CROSS without JOIN', () => {
    const lexer = new Lexer('SELECT * FROM users CROSS orders');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected JOIN after CROSS but got IDENTIFIER');
  });

  it('should parse JOIN with ON clause', () => {
    const lexer = new Lexer('SELECT * FROM users JOIN orders ON users.id = orders.user_id');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [
        { type: 'Table', name: 'USERS' },
        {
          type: 'Join',
          table: { type: 'Table', name: 'ORDERS' },
          joinType: 'INNER',
          on: {
            type: 'ComparisonExpression',
            left: { type: 'Identifier', name: 'USERS.ID' },
            operator: '=',
            right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
          },
        },
      ],
      columns: [{ type: 'Identifier', name: '*' }],
      where: undefined,
      orderBy: undefined,
    });
  });

  it('should parse multiple JOIN ... ON clauses', () => {
    const lexer = new Lexer(
      'SELECT * FROM users JOIN orders ON users.id = orders.user_id JOIN payments ON orders.id = payments.order_id',
    );
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [
        { type: 'Table', name: 'USERS' },
        {
          type: 'Join',
          table: { type: 'Table', name: 'ORDERS' },
          joinType: 'INNER',
          on: {
            type: 'ComparisonExpression',
            left: { type: 'Identifier', name: 'USERS.ID' },
            operator: '=',
            right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
          },
        },
        {
          type: 'Join',
          table: { type: 'Table', name: 'PAYMENTS' },
          joinType: 'INNER',
          on: {
            type: 'ComparisonExpression',
            left: { type: 'Identifier', name: 'ORDERS.ID' },
            operator: '=',
            right: { type: 'Identifier', name: 'PAYMENTS.ORDER_ID' },
          },
        },
      ],
      columns: [{ type: 'Identifier', name: '*' }],
      where: undefined,
      orderBy: undefined,
    });
  });

  it('should throw when JOIN is missing ON', () => {
    const lexer = new Lexer('SELECT * FROM users JOIN orders');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow(/Expected ON/);
  });

  it('should parse dot notation in SELECT columns', () => {
    const lexer = new Lexer('SELECT users.id FROM users');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: 'USERS.ID' }],
      where: undefined,
      orderBy: undefined,
    });
  });

  it('should parse dot notation on both sides of comparison', () => {
    const lexer = new Lexer('SELECT * FROM users, orders WHERE users.id = orders.user_id');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [
        { type: 'Table', name: 'USERS' },
        { type: 'Table', name: 'ORDERS' },
      ],
      columns: [{ type: 'Identifier', name: '*' }],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
      orderBy: undefined,
    });
  });

  it('should throw when dot is not followed by identifier', () => {
    const lexer = new Lexer('SELECT users. FROM users');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected identifier after dot but got FROM');
  });

  it('should parse INNER JOIN with ON clause', () => {
    const lexer = new Lexer('SELECT * FROM users INNER JOIN orders ON users.id = orders.user_id');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.from[1]).toEqual({
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'INNER',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
    });
  });

  it('should parse LEFT JOIN with ON clause', () => {
    const lexer = new Lexer('SELECT * FROM users LEFT JOIN orders ON users.id = orders.user_id');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.from[1]).toEqual({
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'LEFT',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
    });
  });

  it('should parse LEFT OUTER JOIN with ON clause', () => {
    const lexer = new Lexer('SELECT * FROM users LEFT OUTER JOIN orders ON users.id = orders.user_id');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.from[1]).toEqual({
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'LEFT',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
    });
  });

  it('should parse RIGHT JOIN with ON clause', () => {
    const lexer = new Lexer('SELECT * FROM users RIGHT JOIN orders ON users.id = orders.user_id');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.from[1]).toEqual({
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'RIGHT',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
    });
  });

  it('should parse RIGHT OUTER JOIN with ON clause', () => {
    const lexer = new Lexer('SELECT * FROM users RIGHT OUTER JOIN orders ON users.id = orders.user_id');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.from[1]).toEqual({
      type: 'Join',
      table: { type: 'Table', name: 'ORDERS' },
      joinType: 'RIGHT',
      on: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'USERS.ID' },
        operator: '=',
        right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
      },
    });
  });

  it('should parse SELECT with LIMIT clause', () => {
    const lexer = new Lexer('SELECT * FROM users LIMIT 10');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: '*' }],
      where: undefined,
      orderBy: undefined,
      limit: {
        type: 'LimitOffset',
        limit: 10,
        offset: undefined,
      },
    });
  });

  it('should parse SELECT with LIMIT and OFFSET clause', () => {
    const lexer = new Lexer('SELECT * FROM users LIMIT 10 OFFSET 5');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [{ type: 'Identifier', name: '*' }],
      where: undefined,
      orderBy: undefined,
      limit: {
        type: 'LimitOffset',
        limit: 10,
        offset: 5,
      },
    });
  });

  it('should parse SELECT with WHERE, ORDER BY and LIMIT OFFSET', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE age > 30 ORDER BY name ASC LIMIT 20 OFFSET 10');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.limit).toEqual({
      type: 'LimitOffset',
      limit: 20,
      offset: 10,
    });
  });

  it('should parse SELECT DISTINCT', () => {
    const lexer = new Lexer('SELECT DISTINCT name FROM users');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.distinct).toBe(true);
    expect(ast.columns).toEqual([{ type: 'Identifier', name: 'NAME' }]);
  });

  it('should parse SELECT without DISTINCT as false', () => {
    const lexer = new Lexer('SELECT name FROM users');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.distinct).toBe(false);
    expect(ast.columns).toEqual([{ type: 'Identifier', name: 'NAME' }]);
  });

  it('should parse SELECT DISTINCT with multiple columns', () => {
    const lexer = new Lexer('SELECT DISTINCT name, email FROM users');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.distinct).toBe(true);
    expect(ast.columns).toEqual([
      { type: 'Identifier', name: 'NAME' },
      { type: 'Identifier', name: 'EMAIL' },
    ]);
  });

  it('should parse SELECT DISTINCT * FROM users', () => {
    const lexer = new Lexer('SELECT DISTINCT * FROM users');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.distinct).toBe(true);
    expect(ast.columns).toEqual([{ type: 'Identifier', name: '*' }]);
  });

  it('should parse SELECT DISTINCT with WHERE clause', () => {
    const lexer = new Lexer('SELECT DISTINCT email FROM users WHERE active = 1');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.distinct).toBe(true);
    expect(ast.where).toEqual({
      type: 'ComparisonExpression',
      left: { type: 'Identifier', name: 'ACTIVE' },
      operator: '=',
      right: { type: 'Literal', valueType: 'number', value: 1 },
    });
  });

  it('should parse SELECT DISTINCT with ORDER BY', () => {
    const lexer = new Lexer('SELECT DISTINCT name FROM users ORDER BY name ASC');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.distinct).toBe(true);
    expect(ast.orderBy).toBeDefined();
    expect(ast.orderBy?.items).toEqual([{ column: { type: 'Identifier', name: 'NAME' }, direction: 'ASC' }]);
  });

  it('should parse SELECT DISTINCT with LIMIT', () => {
    const lexer = new Lexer('SELECT DISTINCT name FROM users LIMIT 10');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.distinct).toBe(true);
    expect(ast.limit).toEqual({
      type: 'LimitOffset',
      limit: 10,
      offset: undefined,
    });
  });

  it('should parse SELECT DISTINCT with WHERE, ORDER BY and LIMIT', () => {
    const lexer = new Lexer("SELECT DISTINCT email FROM users WHERE status = 'active' ORDER BY email DESC LIMIT 50");
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.distinct).toBe(true);
    expect(ast.where).toBeDefined();
    expect(ast.orderBy).toBeDefined();
    expect(ast.limit).toBeDefined();
  });

  it('should parse SELECT DISTINCT with JOIN', () => {
    const lexer = new Lexer('SELECT DISTINCT users.name FROM users JOIN orders ON users.id = orders.user_id');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.distinct).toBe(true);
    expect(ast.from).toHaveLength(2);
    expect(ast.from[1].type).toBe('Join');
  });

  it('should parse WHERE IN with numeric values', () => {
    const lexer = new Lexer('SELECT * FROM users WHERE id IN (1, 2, 3)');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.where).toEqual({
      type: 'InExpression',
      left: { type: 'Identifier', name: 'ID' },
      values: [
        { type: 'Literal', valueType: 'number', value: 1 },
        { type: 'Literal', valueType: 'number', value: 2 },
        { type: 'Literal', valueType: 'number', value: 3 },
      ],
    });
  });

  it('should parse WHERE IN with string values', () => {
    const lexer = new Lexer("SELECT * FROM users WHERE city IN ('AMS', 'RTM')");
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.where).toEqual({
      type: 'InExpression',
      left: { type: 'Identifier', name: 'CITY' },
      values: [
        { type: 'Literal', valueType: 'string', value: 'AMS' },
        { type: 'Literal', valueType: 'string', value: 'RTM' },
      ],
    });
  });

  it('should throw when IN list is not closed', () => {
    const lexer = new Lexer('SELECT * FROM users WHERE id IN (1, 2, 3');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow();
  });

  it('should parse SELECT with COUNT(*) and AVG(identifier)', () => {
    const lexer = new Lexer('SELECT COUNT(*), AVG(age) FROM users');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [
        {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Wildcard', value: '*' },
        },
        {
          type: 'AggregateFunction',
          functionName: 'AVG',
          argument: { type: 'Identifier', name: 'AGE' },
        },
      ],
      where: undefined,
      orderBy: undefined,
      limit: undefined,
    });
  });

  it('should parse SELECT with SUM, MIN and MAX aggregates', () => {
    const lexer = new Lexer('SELECT SUM(age), MIN(age), MAX(age) FROM users');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.columns).toEqual([
      {
        type: 'AggregateFunction',
        functionName: 'SUM',
        argument: { type: 'Identifier', name: 'AGE' },
      },
      {
        type: 'AggregateFunction',
        functionName: 'MIN',
        argument: { type: 'Identifier', name: 'AGE' },
      },
      {
        type: 'AggregateFunction',
        functionName: 'MAX',
        argument: { type: 'Identifier', name: 'AGE' },
      },
    ]);
  });

  it('should throw for unsupported aggregate function name', () => {
    const lexer = new Lexer('SELECT MEDIAN(age) FROM users');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Unsupported function in SELECT clause: MEDIAN');
  });

  it('should throw when aggregate argument is missing', () => {
    const lexer = new Lexer('SELECT COUNT() FROM users');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected aggregate argument but got RIGHT_PAREN');
  });

  it('should throw when SUM is used with wildcard argument', () => {
    const lexer = new Lexer('SELECT SUM(*) FROM users');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Only COUNT supports wildcard argument');
  });

  it('should parse GROUP BY with aggregate select', () => {
    const lexer = new Lexer('SELECT city, COUNT(*) FROM users GROUP BY city');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [
        { type: 'Identifier', name: 'CITY' },
        {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Wildcard', value: '*' },
        },
      ],
      where: undefined,
      groupBy: [{ type: 'Identifier', name: 'CITY' }],
      having: undefined,
      orderBy: undefined,
      limit: undefined,
    });
  });

  it('should parse GROUP BY with multiple columns', () => {
    const lexer = new Lexer('SELECT city, status, COUNT(*) FROM users GROUP BY city, status');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.groupBy).toEqual([
      { type: 'Identifier', name: 'CITY' },
      { type: 'Identifier', name: 'STATUS' },
    ]);
  });

  it('should parse GROUP BY and HAVING with aggregate expression', () => {
    const lexer = new Lexer('SELECT city, COUNT(*) FROM users GROUP BY city HAVING COUNT(*) > 5');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast).toEqual({
      type: 'SelectStatement',
      distinct: false,
      from: [{ type: 'Table', name: 'USERS' }],
      columns: [
        { type: 'Identifier', name: 'CITY' },
        {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Wildcard', value: '*' },
        },
      ],
      where: undefined,
      groupBy: [{ type: 'Identifier', name: 'CITY' }],
      having: {
        type: 'ComparisonExpression',
        left: {
          type: 'AggregateFunction',
          functionName: 'COUNT',
          argument: { type: 'Wildcard', value: '*' },
        },
        operator: '>',
        right: { type: 'Literal', valueType: 'number', value: 5 },
      },
      orderBy: undefined,
      limit: undefined,
    });
  });

  it('should throw when HAVING is used without GROUP BY', () => {
    const lexer = new Lexer('SELECT COUNT(*) FROM users HAVING COUNT(*) > 5');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('HAVING clause requires GROUP BY');
  });

  it('should parse INSERT INTO with a single values tuple', () => {
    const lexer = new Lexer("INSERT INTO users (id, name, age) VALUES (1, 'Alice', 30)");
    const parser = new Parser(lexer);
    const ast = asInsertStatement(parser.parse());

    expect(ast).toEqual({
      type: 'InsertStatement',
      table: { type: 'Table', name: 'USERS' },
      columns: [
        { type: 'Identifier', name: 'ID' },
        { type: 'Identifier', name: 'NAME' },
        { type: 'Identifier', name: 'AGE' },
      ],
      values: [
        [
          { type: 'Literal', valueType: 'number', value: 1 },
          { type: 'Literal', valueType: 'string', value: 'Alice' },
          { type: 'Literal', valueType: 'number', value: 30 },
        ],
      ],
    });
  });

  it('should parse INSERT INTO with multiple values tuples', () => {
    const lexer = new Lexer("INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob')");
    const parser = new Parser(lexer);
    const ast = asInsertStatement(parser.parse());

    expect(ast.values).toEqual([
      [
        { type: 'Literal', valueType: 'number', value: 1 },
        { type: 'Literal', valueType: 'string', value: 'Alice' },
      ],
      [
        { type: 'Literal', valueType: 'number', value: 2 },
        { type: 'Literal', valueType: 'string', value: 'Bob' },
      ],
    ]);
  });

  it('should throw when INSERT is missing INTO', () => {
    const lexer = new Lexer('INSERT users (id) VALUES (1)');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected token INTO but got IDENTIFIER');
  });

  it('should throw when INSERT is missing VALUES keyword', () => {
    const lexer = new Lexer('INSERT INTO users (id) (1)');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected VALUES after table name but got LEFT_PAREN');
  });

  it('should throw when INSERT has empty column list', () => {
    const lexer = new Lexer('INSERT INTO users () VALUES (1)');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected column name after ( but got RIGHT_PAREN');
  });

  it('should throw when INSERT has empty values tuple', () => {
    const lexer = new Lexer('INSERT INTO users (id) VALUES ()');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected at least one value in VALUES tuple but got RIGHT_PAREN');
  });

  it('should throw when column count and values count do not match', () => {
    const lexer = new Lexer('INSERT INTO users (id, name) VALUES (1)');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Column count 2 does not match values count 1');
  });

  it('should parse OUTER JOIN with ON clause', () => {
    const lexer = new Lexer('SELECT * FROM users OUTER JOIN orders ON users.id = orders.user_id');
    const parser = new Parser(lexer);
    const ast = asSelectStatement(parser.parse());

    expect(ast.from).toEqual([
      { type: 'Table', name: 'USERS' },
      {
        type: 'Join',
        joinType: 'OUTER',
        table: { type: 'Table', name: 'ORDERS' },
        on: {
          type: 'ComparisonExpression',
          left: { type: 'Identifier', name: 'USERS.ID' },
          operator: '=',
          right: { type: 'Identifier', name: 'ORDERS.USER_ID' },
        },
      },
    ]);
  });

  it('should throw when OUTER JOIN is missing a table name', () => {
    const lexer = new Lexer('SELECT * FROM users OUTER JOIN');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected table name after JOIN but got EOF');
  });

  it('should throw when LIMIT is missing a numeric value', () => {
    const lexer = new Lexer('SELECT * FROM users LIMIT');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected number after LIMIT but got EOF');
  });

  it('should throw when OFFSET is missing a numeric value', () => {
    const lexer = new Lexer('SELECT * FROM users LIMIT 10 OFFSET');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected number after OFFSET but got EOF');
  });

  it('should throw when SELECT FROM is missing a table name', () => {
    const lexer = new Lexer('SELECT name FROM');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected table name after FROM but got EOF');
  });

  it('should throw when SELECT FROM has a trailing comma without a table name', () => {
    const lexer = new Lexer('SELECT name FROM users,');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected table name after COMMA but got EOF');
  });

  it('should throw when GROUP BY is missing a column name', () => {
    const lexer = new Lexer('SELECT city, COUNT(*) FROM users GROUP BY');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected at least one column after GROUP BY but got EOF');
  });

  it('should throw when GROUP BY has a trailing comma without a column name', () => {
    const lexer = new Lexer('SELECT city, COUNT(*) FROM users GROUP BY city,');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected column name after COMMA but got EOF');
  });

  it('should throw when DELETE FROM has a trailing comma without a table name', () => {
    const lexer = new Lexer('DELETE FROM users,');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected table name after COMMA but got EOF');
  });

  it('should throw when DELETE uses JOIN syntax', () => {
    const lexer = new Lexer('DELETE FROM users JOIN orders');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('JOIN is not supported in DELETE statements');
  });

  it('should throw when DELETE FROM is missing the first table name', () => {
    const lexer = new Lexer('DELETE FROM');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected table name after FROM but got EOF');
  });

  it('should parse DELETE with multiple tables', () => {
    const lexer = new Lexer('DELETE FROM users, orders');
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'DeleteStatement',
      from: [
        { type: 'Table', name: 'USERS' },
        { type: 'Table', name: 'ORDERS' },
      ],
      where: undefined,
    });
  });

  it('should parse UPDATE with SET and WHERE', () => {
    const lexer = new Lexer("UPDATE users SET name = 'Alice' WHERE id = 1");
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'NAME' },
          value: { type: 'Literal', valueType: 'string', value: 'Alice' },
        },
      ],
      where: {
        type: 'ComparisonExpression',
        left: { type: 'Identifier', name: 'ID' },
        operator: '=',
        right: { type: 'Literal', valueType: 'number', value: 1 },
      },
    });
  });

  it('should parse UPDATE with SET and no WHERE', () => {
    const lexer = new Lexer("UPDATE users SET name = 'Alice'");
    const parser = new Parser(lexer);
    const ast = parser.parse();

    expect(ast).toEqual({
      type: 'UpdateStatement',
      table: { type: 'Table', name: 'USERS' },
      set: [
        {
          column: { type: 'Identifier', name: 'NAME' },
          value: { type: 'Literal', valueType: 'string', value: 'Alice' },
        },
      ],
      where: undefined,
    });
  });

  it('should throw when UPDATE SET is missing a column name', () => {
    const lexer = new Lexer("UPDATE users SET = 'Alice'");
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected column name after SET but got EQUALS');
  });

  it('should throw when UPDATE SET is missing the equals sign', () => {
    const lexer = new Lexer("UPDATE users SET name 'Alice'");
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected = after column name but got STRING');
  });

  it('should throw when INSERT column list is missing the opening parenthesis', () => {
    const lexer = new Lexer('INSERT INTO users id VALUES (1)');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected ( after table name but got IDENTIFIER');
  });

  it('should throw when INSERT column list has a trailing comma', () => {
    const lexer = new Lexer('INSERT INTO users (id,) VALUES (1)');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected column name after COMMA but got RIGHT_PAREN');
  });

  it('should throw when INSERT VALUES is missing the opening parenthesis', () => {
    const lexer = new Lexer('INSERT INTO users (id) VALUES 1');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Expected at least one values tuple after VALUES but got NUMBER');
  });

  it('should throw when trailing tokens appear after INSERT values', () => {
    const lexer = new Lexer('INSERT INTO users (id) VALUES (1) EXTRA');
    const parser = new Parser(lexer);

    expect(() => parser.parse()).toThrow('Unexpected token after INSERT values: IDENTIFIER');
  });
});
