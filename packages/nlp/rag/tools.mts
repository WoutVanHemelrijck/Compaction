// @author Tijn
// @date 2026-05-02
import { hnswIndexImpl } from '../text-embedding/hnsw-index.mjs';

/**
 * Retrieve related documents from the project's HNSW vector index.
 *
 * @param {hnswIndexImpl} hnswIndex - An opened instance of the HNSW index.
 * @param {string} query - The natural-language query to search for.
 * @param {number} [topK=5] - Number of top matches to return.
 * @returns {Promise<Array<{id: string, text: string | null, metadata?: Record<string, unknown>}>>}
 */
export async function getRelatedDocuments(
  hnswIndex: hnswIndexImpl,
  query: string,
  topK: number = 5,
): Promise<Array<{ id: string; text: string | null; metadata?: Record<string, unknown> }>> {
  const ids = await hnswIndex.search(query, topK);
  const results: Array<{ id: string; text: string | null; metadata?: Record<string, unknown> }> = [];
  for (const id of ids) {
    try {
      const doc = await hnswIndex.collection.findById(id);
      const text = doc ? `${doc.id}\n${doc['title'] as string}\n${doc['content'] as string}` : null;
      results.push({ id, text, metadata: doc ? { id, name: doc['name'] as string } : undefined });
    } catch {
      results.push({ id, text: null });
    }
  }
  return results;
}
