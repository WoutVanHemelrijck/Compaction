//@author Tijn Gommers
//@date 2026-04-02

import { describe, expect, it } from 'vitest';
import { Lexer } from '../../../src/lexer/lexer.mjs';
import { Parser } from '../../../src/parser/parser.mjs';
import type { SelectStatement } from '../../../src/types/index.mjs';
import { SelectOptimizer } from '../../../src/executors/select-optimizer.mjs';

describe('SelectOptimizer', () => {
  const optimizer = new SelectOptimizer();

  it('should cascade selections connected by AND', () => {
    const statement = parseSelect("SELECT name FROM users WHERE age > 18 AND city = 'AMS' AND active = 1");

    const optimized = optimizer.optimize(statement);

    expect(optimized.cascadedSelections).toHaveLength(3);
  });

  it('should commute and push single-table selections', () => {
    const statement = parseSelect(
      'SELECT users.name FROM users, orders WHERE users.id = orders.user_id AND users.age > 18',
    );

    const optimized = optimizer.optimize(statement);

    expect(optimized.pushedSelectionsByTable['USERS']).toHaveLength(1);
    expect(optimized.pushedSelectionsByTable['USERS'][0]).toEqual({
      type: 'ComparisonExpression',
      left: { type: 'Identifier', name: 'USERS.AGE' },
      operator: '>',
      right: { type: 'Literal', valueType: 'number', value: 18 },
    });
  });

  it('should push projection columns per table', () => {
    const statement = parseSelect('SELECT users.name FROM users WHERE users.age > 18');

    const optimized = optimizer.optimize(statement);

    expect(optimized.projectionByTable['USERS']).toEqual(expect.arrayContaining(['NAME', 'AGE']));
  });

  it('should introduce INNER JOIN from equi-join predicate', () => {
    const statement = parseSelect('SELECT * FROM users, orders WHERE users.id = orders.user_id');

    const optimized = optimizer.optimize(statement);

    expect(optimized.introducedJoins).toHaveLength(1);
    expect(optimized.introducedJoins[0].joinType).toBe('INNER');
    expect(optimized.introducedJoins[0].table.name).toBe('ORDERS');
  });
});

function parseSelect(query: string): SelectStatement {
  const parser = new Parser(new Lexer(query));
  return parser.parse() as SelectStatement;
}
