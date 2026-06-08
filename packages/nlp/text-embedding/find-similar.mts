// @author Jari, AG
// @date 2026-02-24

/**
 * Calculates the magnitude of the given number vector to 2 decimal spaces.
 * @param {Array<number>} vct the vector whose magnitude will be calculated
 * @returns {number} the magnitude of vct
 */
export function getMagnitude(vct: Array<number>): number {
  if (vct.length === 0) {
    throw new Error(`The inputvector must be non-empty, but size was ${vct.length}`);
  }
  const res: number = Math.sqrt(vct.reduce((acc, curr) => acc + curr ** 2, 0));
  return Math.round(res * 100) / 100;
}

/**
 * Calculates the dot product of 2 equal length vectors a and b.
 * @param {Array<number>} a the first vector
 * @param {Array<number>} b the second vector
 * @returns {number} the dot product of a and b
 */
export function getDotProduct(a: Array<number>, b: Array<number>): number {
  if (a.length !== b.length) {
    throw new Error(`Input vectors must be the same size, but actual sizes were a=${a.length}, b=${b.length}`);
  }
  if (a.length === 0 || b.length === 0) {
    throw new Error(`Input vectors must be non-empty, but actual sizes were a=${a.length}, b=${b.length}`);
  }

  let res: number = 0;
  for (let i = 0; i < a.length; i++) {
    res += a[i] * b[i];
  }
  return res;
}

/**
 * Calculates the cosine distance rounded to 2 decimals between 2 vectors.
 * @param {Array<number>} a first non-empty sparse counting vector
 * @param {Array<number>} b second non-empty sparse counting vector
 * @returns {number} the cosine distance between vectors a and b
 */
export function cosineDistance(a: Array<number>, b: Array<number>): number {
  const magnitudeA: number = getMagnitude(a);
  const magnitudeB: number = getMagnitude(b);
  const dotProduct: number = getDotProduct(a, b);
  const cos_similarity: number = dotProduct / (magnitudeA * magnitudeB);
  const cos_distance: number = 1 - cos_similarity;

  return cos_distance;
  //return Math.round(100 * cos_distance) / 100;
}
