// @author Tijn Gommers
// @date 2026-05-05

import { describe, it, expect, vi } from 'vitest';
import { getRelatedDocuments } from './tools.mjs';
import { hnswIndexImpl } from '../text-embedding/hnsw-index.mjs';

type DocumentRecord = {
  id: string;
  name: string;
  title: string;
  content: string;
};

describe('getRelatedDocuments', () => {
  it('returns related documents based on the HNSW index search results', async () => {
    const searchMock = vi.fn<() => Promise<string[]>>().mockResolvedValue(['id1', 'id2']);
    const findByIdMock = vi
      .fn<(id: string) => Promise<DocumentRecord | null>>()
      .mockResolvedValueOnce({
        id: 'id1',
        name: 'Document 1',
        title: 'Document 1',
        content: 'This is the first document.',
      })
      .mockResolvedValueOnce({
        id: 'id2',
        name: 'Document 2',
        title: 'Document 2',
        content: 'This is the second document.',
      });

    const mockHnswIndex = {
      search: searchMock,
      collection: {
        findById: findByIdMock,
      },
    } as unknown as hnswIndexImpl;

    const results = await getRelatedDocuments(mockHnswIndex, 'test query', 2);
    expect(searchMock).toHaveBeenCalledWith('test query', 2);
    expect(findByIdMock).toHaveBeenCalledWith('id1');
    expect(findByIdMock).toHaveBeenCalledWith('id2');
    expect(results).toEqual([
      { id: 'id1', text: 'id1\nDocument 1\nThis is the first document.', metadata: { id: 'id1', name: 'Document 1' } },
      { id: 'id2', text: 'id2\nDocument 2\nThis is the second document.', metadata: { id: 'id2', name: 'Document 2' } },
    ]);
  });
});
