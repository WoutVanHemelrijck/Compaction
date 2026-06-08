// @author mh
// @date 2025-10-27
import { applyFilters } from './filters-streamify.mjs';
import { it, expect, describe } from 'vitest';

describe('filters-streamify - applyFilters', () => {
  // Test 1: String input
  it('should work with strings', () => {
    const input = 'I HAVE 3 Carrots!!!';
    const result = applyFilters(input, 'eng');
    expect(result).toBe('carrot');
  });

  it('should handle empty string', () => {
    expect(applyFilters('', 'eng')).toBe('');
  });

  it('should remove punctuation before removing common words', () => {
    const input = "don't test";
    const result = applyFilters(input, 'eng');
    expect(result).toBe('test');
  });

  // Test 2: Sync iterable
  it('should work with sync iterables', () => {
    const input = ['I HAVE 3 Carrots!!!', 'The 42 QUICK foxes...'];
    const result = [...applyFilters(input, 'eng')];
    expect(result).toEqual(['carrots', 'quick foxes']);
  });

  it('should handle empty arrays', () => {
    const input: string[] = [];
    const result = [...applyFilters(input, 'eng')];
    expect(result).toEqual([]);
  });

  it('should handle arrays with empty strings', () => {
    const input = ['Hello', '', 'World'];
    const result = [...applyFilters(input, 'eng')];
    expect(result).toEqual(['', '', 'world']);
  });

  // Test 3: Async iterable
  it('should work with async iterables', async () => {
    async function* generator() {
      await Promise.resolve();
      yield 'I HAVE 3 Carrots!!!';
      yield 'The 42 QUICK foxes...';
    }

    const result = [];
    for await (const chunk of applyFilters(generator(), 'eng')) {
      result.push(chunk);
    }
    expect(result).toEqual(['carrots', 'quick foxes']);
  });

  it('should handle async generator with various inputs', async () => {
    async function* generator() {
      await Promise.resolve();
      yield 'HELLO WORLD 123';
      yield 'The Quick Brown Fox!';
      yield '';
    }

    const result = [];
    for await (const chunk of applyFilters(generator(), 'eng')) {
      result.push(chunk);
    }
    expect(result[0]).toBe('world');
    expect(result[1]).toBe('quick brown fox');
    expect(result[2]).toBe('');
  });
});
