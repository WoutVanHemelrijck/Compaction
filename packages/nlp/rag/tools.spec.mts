// @author Tijn Gommers
// @date 2026-05-05

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getRelatedDocuments } from './tools.mjs';
import { hnswIndexImpl } from '../text-embedding/hnsw-index.mjs';

type DocumentRecord = {
  id: string;
  name: string;
  title: string;
  content: string;
};

describe('getRelatedDocuments', () => {
  let searchMock: ReturnType<typeof vi.fn<() => Promise<string[]>>>;
  let findByIdMock: ReturnType<typeof vi.fn<(id: string) => Promise<DocumentRecord | null>>>;
  let mockHnswIndex: hnswIndexImpl;
  beforeEach(() => {
    searchMock = vi.fn<() => Promise<string[]>>();
    findByIdMock = vi.fn<(id: string) => Promise<DocumentRecord | null>>();

    mockHnswIndex = {
      search: searchMock,
      collection: {
        findById: findByIdMock,
      },
    } as unknown as hnswIndexImpl;
  });

  it('returns related documents based on the HNSW index search results', async () => {
    searchMock.mockResolvedValue(['id1', 'id2']);
    findByIdMock
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

    const results = await getRelatedDocuments(mockHnswIndex, 'test query', 2);
    expect(searchMock).toHaveBeenCalledWith('test query', 2);
    expect(findByIdMock).toHaveBeenCalledWith('id1');
    expect(findByIdMock).toHaveBeenCalledWith('id2');
    expect(results).toEqual([
      { id: 'id1', text: 'id1\nDocument 1\nThis is the first document.', metadata: { id: 'id1', name: 'Document 1' } },
      { id: 'id2', text: 'id2\nDocument 2\nThis is the second document.', metadata: { id: 'id2', name: 'Document 2' } },
    ]);
  });

  it('handles cases where documents are not found', async () => {
    searchMock.mockResolvedValue(['id1']);
    findByIdMock.mockResolvedValue(null);
    const results = await getRelatedDocuments(mockHnswIndex, 'test query');
    expect(results).toEqual([{ id: 'id1', text: null }]);
  });

  it('handles errors when retrieving documents', async () => {
    searchMock.mockResolvedValue(['id1']);
    findByIdMock.mockRejectedValue(new Error('Database error'));
    const results = await getRelatedDocuments(mockHnswIndex, 'test query');
    expect(results).toEqual([{ id: 'id1', text: null }]);
  });
});
