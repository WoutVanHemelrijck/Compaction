import { it, expect, describe } from 'vitest';
import { cosineDistance, getDotProduct, getMagnitude } from './find-similar.mjs';

describe('getMagnitude', () => {
  it('should return the correct magnitude', () => {
    expect(getMagnitude([5, 8, 17])).toEqual(19.44);
    expect(getMagnitude([-5, 8, 17])).toEqual(19.44);
    expect(() => getMagnitude([])).toThrow();
  });
});

describe('getDotProduct', () => {
  it('should return the correct dot product', () => {
    expect(getDotProduct([5, 8], [-7, 4])).toEqual(-3);
    expect(() => getDotProduct([5], [8, 8, 7])).toThrow();
    expect(() => getDotProduct([], [])).toThrow();
  });
});

describe('cosineDistance', () => {
  it('should return the correct cosine distance', () => {
    expect(cosineDistance([5, 8], [55, -5])).toBeCloseTo(0.55, 2);
    expect(cosineDistance([1, 1], [1, 0])).toBeCloseTo(0.29, 2);
    expect(cosineDistance([1, 2], [0, 15])).toBeCloseTo(0.11, 2);
    expect(cosineDistance([5, 8, 0], [0, 0, 5])).toBeCloseTo(1, 5);
  });
});
