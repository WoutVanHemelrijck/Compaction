// @author Tijn Gommers
// @date 2026-03-17

import { TokenType } from '../../src/types/index.mjs';
import { Lexer } from '../../src/lexer/lexer.mjs';
import { describe, it, expect } from 'vitest';

describe('Lexer', () => {
  it('Tokenization should work for all common SQL keywords and operators', () => {
    const lexer = new Lexer("SELECT name FROM users WHERE id = 10 AND age > 20 OR city = 'New York' AND score < 100");
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.IDENTIFIER, value: 'NAME' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.WHERE, value: 'WHERE' },
      { type: TokenType.IDENTIFIER, value: 'ID' },
      { type: TokenType.EQUALS, value: '=' },
      { type: TokenType.NUMBER, value: '10' },
      { type: TokenType.AND, value: 'AND' },
      { type: TokenType.IDENTIFIER, value: 'AGE' },
      { type: TokenType.GREATER_THAN, value: '>' },
      { type: TokenType.NUMBER, value: '20' },
      { type: TokenType.OR, value: 'OR' },
      { type: TokenType.IDENTIFIER, value: 'CITY' },
      { type: TokenType.EQUALS, value: '=' },
      { type: TokenType.STRING, value: 'New York' },
      { type: TokenType.AND, value: 'AND' },
      { type: TokenType.IDENTIFIER, value: 'SCORE' },
      { type: TokenType.LESS_THAN, value: '<' },
      { type: TokenType.NUMBER, value: '100' },
    ]);
  });

  it('should correctly tokenize <= and >=', () => {
    const lexer = new Lexer('SELECT a FROM users WHERE age >= 18 AND age <= 30');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.IDENTIFIER, value: 'A' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.WHERE, value: 'WHERE' },
      { type: TokenType.IDENTIFIER, value: 'AGE' },
      { type: TokenType.GREATER_THAN_OR_EQUALS, value: '>=' },
      { type: TokenType.NUMBER, value: '18' },
      { type: TokenType.AND, value: 'AND' },
      { type: TokenType.IDENTIFIER, value: 'AGE' },
      { type: TokenType.LESS_THAN_OR_EQUALS, value: '<=' },
      { type: TokenType.NUMBER, value: '30' },
    ]);
  });

  it('should correctly tokenize !=', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE age != 18');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.IDENTIFIER, value: 'NAME' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.WHERE, value: 'WHERE' },
      { type: TokenType.IDENTIFIER, value: 'AGE' },
      { type: TokenType.NOT_EQUALS, value: '!=' },
      { type: TokenType.NUMBER, value: '18' },
    ]);
  });

  it('should tokenize commas in column lists', () => {
    const lexer = new Lexer('SELECT name, age FROM users');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.IDENTIFIER, value: 'NAME' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.IDENTIFIER, value: 'AGE' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
    ]);
  });

  it('should tokenize star in select list', () => {
    const lexer = new Lexer('SELECT * FROM users');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.STAR, value: '*' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
    ]);
  });

  it('should tokenize NOT as keyword', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE NOT age = 18');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.IDENTIFIER, value: 'NAME' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.WHERE, value: 'WHERE' },
      { type: TokenType.NOT, value: 'NOT' },
      { type: TokenType.IDENTIFIER, value: 'AGE' },
      { type: TokenType.EQUALS, value: '=' },
      { type: TokenType.NUMBER, value: '18' },
    ]);
  });

  it('should tokenize parenthesized WHERE expression', () => {
    const lexer = new Lexer("SELECT name FROM users WHERE (age > 18 AND city = 'AMS') OR status = 'active'");
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.IDENTIFIER, value: 'NAME' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.WHERE, value: 'WHERE' },
      { type: TokenType.LEFT_PAREN, value: '(' },
      { type: TokenType.IDENTIFIER, value: 'AGE' },
      { type: TokenType.GREATER_THAN, value: '>' },
      { type: TokenType.NUMBER, value: '18' },
      { type: TokenType.AND, value: 'AND' },
      { type: TokenType.IDENTIFIER, value: 'CITY' },
      { type: TokenType.EQUALS, value: '=' },
      { type: TokenType.STRING, value: 'AMS' },
      { type: TokenType.RIGHT_PAREN, value: ')' },
      { type: TokenType.OR, value: 'OR' },
      { type: TokenType.IDENTIFIER, value: 'STATUS' },
      { type: TokenType.EQUALS, value: '=' },
      { type: TokenType.STRING, value: 'active' },
    ]);
  });

  it('should tokenize arithmetic operators in WHERE clause', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE age + 2 * score / 4 - bonus > 100');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.IDENTIFIER, value: 'NAME' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.WHERE, value: 'WHERE' },
      { type: TokenType.IDENTIFIER, value: 'AGE' },
      { type: TokenType.PLUS, value: '+' },
      { type: TokenType.NUMBER, value: '2' },
      { type: TokenType.STAR, value: '*' },
      { type: TokenType.IDENTIFIER, value: 'SCORE' },
      { type: TokenType.DIVIDE, value: '/' },
      { type: TokenType.NUMBER, value: '4' },
      { type: TokenType.MINUS, value: '-' },
      { type: TokenType.IDENTIFIER, value: 'BONUS' },
      { type: TokenType.GREATER_THAN, value: '>' },
      { type: TokenType.NUMBER, value: '100' },
    ]);
  });

  it('should tokenize IS NULL', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE city IS NULL');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.IDENTIFIER, value: 'NAME' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.WHERE, value: 'WHERE' },
      { type: TokenType.IDENTIFIER, value: 'CITY' },
      { type: TokenType.IS, value: 'IS' },
      { type: TokenType.NULL, value: 'NULL' },
    ]);
  });

  it('should tokenize IS NOT NULL', () => {
    const lexer = new Lexer('SELECT name FROM users WHERE city IS NOT NULL');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.IDENTIFIER, value: 'NAME' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.WHERE, value: 'WHERE' },
      { type: TokenType.IDENTIFIER, value: 'CITY' },
      { type: TokenType.IS, value: 'IS' },
      { type: TokenType.NOT, value: 'NOT' },
      { type: TokenType.NULL, value: 'NULL' },
    ]);
  });

  it('should tokenize ORDER BY with multiple columns and directions', () => {
    const lexer = new Lexer('SELECT name FROM users ORDER BY age DESC, city ASC');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.IDENTIFIER, value: 'NAME' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.ORDER, value: 'ORDER' },
      { type: TokenType.BY, value: 'BY' },
      { type: TokenType.IDENTIFIER, value: 'AGE' },
      { type: TokenType.DESC, value: 'DESC' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.IDENTIFIER, value: 'CITY' },
      { type: TokenType.ASC, value: 'ASC' },
    ]);
  });

  it('should handle whitespace correctly', () => {
    const lexer = new Lexer('   SELECT   name   FROM   users   ');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.IDENTIFIER, value: 'NAME' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
    ]);
  });

  it('should return EOF token at the end of input', () => {
    const lexer = new Lexer('SELECT name');
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      token = lexer.nextToken();
    }
    expect(token.type).toBe(TokenType.EOF);
  });

  it('should throw an error for unknown characters', () => {
    const lexer = new Lexer('@');
    expect(() => lexer.nextToken()).toThrow('Unexpected character: @');
  });

  it('should throw an error for standalone !', () => {
    const lexer = new Lexer('!');
    expect(() => lexer.nextToken()).toThrow('Unexpected character: !');
  });

  it('should throw an error for unclosed string literals', () => {
    const lexer = new Lexer("'Unclosed string");
    expect(() => lexer.nextToken()).toThrow('Unterminated string literal');
  });

  it('should tokenize CROSS JOIN keywords', () => {
    const lexer = new Lexer('SELECT * FROM users CROSS JOIN orders');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.STAR, value: '*' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.CROSS, value: 'CROSS' },
      { type: TokenType.JOIN, value: 'JOIN' },
      { type: TokenType.IDENTIFIER, value: 'ORDERS' },
    ]);
  });

  it('should tokenize JOIN ... ON clauses', () => {
    const lexer = new Lexer('SELECT * FROM users JOIN orders ON users.id = orders.user_id');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.STAR, value: '*' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.JOIN, value: 'JOIN' },
      { type: TokenType.IDENTIFIER, value: 'ORDERS' },
      { type: TokenType.ON, value: 'ON' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.DOT, value: '.' },
      { type: TokenType.IDENTIFIER, value: 'ID' },
      { type: TokenType.EQUALS, value: '=' },
      { type: TokenType.IDENTIFIER, value: 'ORDERS' },
      { type: TokenType.DOT, value: '.' },
      { type: TokenType.IDENTIFIER, value: 'USER_ID' },
    ]);
  });

  it('should tokenize INNER JOIN keyword', () => {
    const lexer = new Lexer('SELECT * FROM users INNER JOIN orders');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.STAR, value: '*' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.INNER, value: 'INNER' },
      { type: TokenType.JOIN, value: 'JOIN' },
      { type: TokenType.IDENTIFIER, value: 'ORDERS' },
    ]);
  });

  it('should tokenize LEFT OUTER JOIN keywords', () => {
    const lexer = new Lexer('SELECT * FROM users LEFT OUTER JOIN orders');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.STAR, value: '*' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.LEFT, value: 'LEFT' },
      { type: TokenType.OUTER, value: 'OUTER' },
      { type: TokenType.JOIN, value: 'JOIN' },
      { type: TokenType.IDENTIFIER, value: 'ORDERS' },
    ]);
  });

  it('should tokenize RIGHT JOIN keyword', () => {
    const lexer = new Lexer('SELECT * FROM users RIGHT JOIN orders');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.STAR, value: '*' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.RIGHT, value: 'RIGHT' },
      { type: TokenType.JOIN, value: 'JOIN' },
      { type: TokenType.IDENTIFIER, value: 'ORDERS' },
    ]);
  });

  it('should tokenize comma-separated table names', () => {
    const lexer = new Lexer('SELECT * FROM users, orders, products');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.STAR, value: '*' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.IDENTIFIER, value: 'ORDERS' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.IDENTIFIER, value: 'PRODUCTS' },
    ]);
  });

  it('should tokenize dot notation identifiers', () => {
    const lexer = new Lexer('SELECT users.id FROM users WHERE users.id = orders.user_id');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.DOT, value: '.' },
      { type: TokenType.IDENTIFIER, value: 'ID' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.WHERE, value: 'WHERE' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.DOT, value: '.' },
      { type: TokenType.IDENTIFIER, value: 'ID' },
      { type: TokenType.EQUALS, value: '=' },
      { type: TokenType.IDENTIFIER, value: 'ORDERS' },
      { type: TokenType.DOT, value: '.' },
      { type: TokenType.IDENTIFIER, value: 'USER_ID' },
    ]);
  });

  it('should tokenize LIMIT clause', () => {
    const lexer = new Lexer('SELECT * FROM users LIMIT 10');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.STAR, value: '*' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.LIMIT, value: 'LIMIT' },
      { type: TokenType.NUMBER, value: '10' },
    ]);
  });

  it('should tokenize LIMIT and OFFSET clause', () => {
    const lexer = new Lexer('SELECT * FROM users LIMIT 10 OFFSET 5');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.STAR, value: '*' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.LIMIT, value: 'LIMIT' },
      { type: TokenType.NUMBER, value: '10' },
      { type: TokenType.OFFSET, value: 'OFFSET' },
      { type: TokenType.NUMBER, value: '5' },
    ]);
  });

  it('should tokenize DISTINCT keyword', () => {
    const lexer = new Lexer('SELECT DISTINCT name FROM users');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.DISTINCT, value: 'DISTINCT' },
      { type: TokenType.IDENTIFIER, value: 'NAME' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
    ]);
  });

  it('should tokenize SELECT DISTINCT * ', () => {
    const lexer = new Lexer('SELECT DISTINCT * FROM users');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.DISTINCT, value: 'DISTINCT' },
      { type: TokenType.STAR, value: '*' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
    ]);
  });

  it('should tokenize SELECT DISTINCT with multiple columns', () => {
    const lexer = new Lexer('SELECT DISTINCT id, email FROM users');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.DISTINCT, value: 'DISTINCT' },
      { type: TokenType.IDENTIFIER, value: 'ID' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.IDENTIFIER, value: 'EMAIL' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
    ]);
  });

  it('should tokenize WHERE IN with numeric list', () => {
    const lexer = new Lexer('SELECT * FROM users WHERE id IN (1, 2, 3)');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.STAR, value: '*' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.WHERE, value: 'WHERE' },
      { type: TokenType.IDENTIFIER, value: 'ID' },
      { type: TokenType.IN, value: 'IN' },
      { type: TokenType.LEFT_PAREN, value: '(' },
      { type: TokenType.NUMBER, value: '1' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.NUMBER, value: '2' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.NUMBER, value: '3' },
      { type: TokenType.RIGHT_PAREN, value: ')' },
    ]);
  });

  it('should tokenize WHERE IN with string list', () => {
    const lexer = new Lexer("SELECT * FROM users WHERE city IN ('AMS', 'RTM')");
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }
    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.STAR, value: '*' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.WHERE, value: 'WHERE' },
      { type: TokenType.IDENTIFIER, value: 'CITY' },
      { type: TokenType.IN, value: 'IN' },
      { type: TokenType.LEFT_PAREN, value: '(' },
      { type: TokenType.STRING, value: 'AMS' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.STRING, value: 'RTM' },
      { type: TokenType.RIGHT_PAREN, value: ')' },
    ]);
  });

  it('should tokenize aggregate functions in SELECT list', () => {
    const lexer = new Lexer('SELECT COUNT(*), AVG(age) FROM users');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }

    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.COUNT, value: 'COUNT' },
      { type: TokenType.LEFT_PAREN, value: '(' },
      { type: TokenType.STAR, value: '*' },
      { type: TokenType.RIGHT_PAREN, value: ')' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.AVG, value: 'AVG' },
      { type: TokenType.LEFT_PAREN, value: '(' },
      { type: TokenType.IDENTIFIER, value: 'AGE' },
      { type: TokenType.RIGHT_PAREN, value: ')' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
    ]);
  });

  it('should tokenize all aggregate function names', () => {
    const lexer = new Lexer('SELECT SUM(age), MIN(age), MAX(age) FROM users');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }

    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.SUM, value: 'SUM' },
      { type: TokenType.LEFT_PAREN, value: '(' },
      { type: TokenType.IDENTIFIER, value: 'AGE' },
      { type: TokenType.RIGHT_PAREN, value: ')' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.MIN, value: 'MIN' },
      { type: TokenType.LEFT_PAREN, value: '(' },
      { type: TokenType.IDENTIFIER, value: 'AGE' },
      { type: TokenType.RIGHT_PAREN, value: ')' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.MAX, value: 'MAX' },
      { type: TokenType.LEFT_PAREN, value: '(' },
      { type: TokenType.IDENTIFIER, value: 'AGE' },
      { type: TokenType.RIGHT_PAREN, value: ')' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
    ]);
  });

  it('should tokenize GROUP BY clause', () => {
    const lexer = new Lexer('SELECT city, COUNT(*) FROM users GROUP BY city');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }

    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.IDENTIFIER, value: 'CITY' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.COUNT, value: 'COUNT' },
      { type: TokenType.LEFT_PAREN, value: '(' },
      { type: TokenType.STAR, value: '*' },
      { type: TokenType.RIGHT_PAREN, value: ')' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.GROUP, value: 'GROUP' },
      { type: TokenType.BY, value: 'BY' },
      { type: TokenType.IDENTIFIER, value: 'CITY' },
    ]);
  });

  it('should tokenize GROUP BY with HAVING aggregate filter', () => {
    const lexer = new Lexer('SELECT city, COUNT(*) FROM users GROUP BY city HAVING COUNT(*) > 5');
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }

    expect(tokens).toEqual([
      { type: TokenType.SELECT, value: 'SELECT' },
      { type: TokenType.IDENTIFIER, value: 'CITY' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.COUNT, value: 'COUNT' },
      { type: TokenType.LEFT_PAREN, value: '(' },
      { type: TokenType.STAR, value: '*' },
      { type: TokenType.RIGHT_PAREN, value: ')' },
      { type: TokenType.FROM, value: 'FROM' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.GROUP, value: 'GROUP' },
      { type: TokenType.BY, value: 'BY' },
      { type: TokenType.IDENTIFIER, value: 'CITY' },
      { type: TokenType.HAVING, value: 'HAVING' },
      { type: TokenType.COUNT, value: 'COUNT' },
      { type: TokenType.LEFT_PAREN, value: '(' },
      { type: TokenType.STAR, value: '*' },
      { type: TokenType.RIGHT_PAREN, value: ')' },
      { type: TokenType.GREATER_THAN, value: '>' },
      { type: TokenType.NUMBER, value: '5' },
    ]);
  });

  it('should tokenize INSERT INTO with column list and VALUES', () => {
    const lexer = new Lexer("INSERT INTO users (id, name, age) VALUES (1, 'Alice', 30)");
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }

    expect(tokens).toEqual([
      { type: TokenType.INSERT, value: 'INSERT' },
      { type: TokenType.INTO, value: 'INTO' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.LEFT_PAREN, value: '(' },
      { type: TokenType.IDENTIFIER, value: 'ID' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.IDENTIFIER, value: 'NAME' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.IDENTIFIER, value: 'AGE' },
      { type: TokenType.RIGHT_PAREN, value: ')' },
      { type: TokenType.VALUES, value: 'VALUES' },
      { type: TokenType.LEFT_PAREN, value: '(' },
      { type: TokenType.NUMBER, value: '1' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.STRING, value: 'Alice' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.NUMBER, value: '30' },
      { type: TokenType.RIGHT_PAREN, value: ')' },
    ]);
  });

  it('should tokenize INSERT with multiple value tuples', () => {
    const lexer = new Lexer("INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob')");
    const tokens = [];
    let token = lexer.nextToken();
    while (token.type !== TokenType.EOF) {
      tokens.push(token);
      token = lexer.nextToken();
    }

    expect(tokens).toEqual([
      { type: TokenType.INSERT, value: 'INSERT' },
      { type: TokenType.INTO, value: 'INTO' },
      { type: TokenType.IDENTIFIER, value: 'USERS' },
      { type: TokenType.LEFT_PAREN, value: '(' },
      { type: TokenType.IDENTIFIER, value: 'ID' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.IDENTIFIER, value: 'NAME' },
      { type: TokenType.RIGHT_PAREN, value: ')' },
      { type: TokenType.VALUES, value: 'VALUES' },
      { type: TokenType.LEFT_PAREN, value: '(' },
      { type: TokenType.NUMBER, value: '1' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.STRING, value: 'Alice' },
      { type: TokenType.RIGHT_PAREN, value: ')' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.LEFT_PAREN, value: '(' },
      { type: TokenType.NUMBER, value: '2' },
      { type: TokenType.COMMA, value: ',' },
      { type: TokenType.STRING, value: 'Bob' },
      { type: TokenType.RIGHT_PAREN, value: ')' },
    ]);
  });
});
