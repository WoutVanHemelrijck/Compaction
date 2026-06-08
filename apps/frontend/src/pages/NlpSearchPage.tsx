import { useState } from 'react';
import { useCollectionStore } from '../stores/collectionStore';
import { hnswSearch, type SearchResult } from '../api/client';

const K_OPTIONS = [1, 3, 5, 10, 20];

export default function NlpSearchPage() {
  const { collections } = useCollectionStore();
  const [selectedCollection, setSelectedCollection] = useState('');
  const [query, setQuery] = useState('');
  const [k, setK] = useState(5);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedCollection) {
      setError('Please select a collection.');
      return;
    }
    if (!query.trim()) {
      setError('Please enter a search query.');
      return;
    }
    setLoading(true);
    setError('');
    setResults(null);
    try {
      setResults(await hnswSearch(selectedCollection, query.trim(), k));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="docs-page">
      <div className="docs-header">
        <span className="breadcrumb-sep">NLP Search</span>
      </div>
      <div className="search-page-body">
        <form className="search-form" onSubmit={(e) => void handleSearch(e)}>
          <div className="search-form-row">
            <div className="form-field" style={{ flex: '0 0 200px' }}>
              <label htmlFor="collection-select">Collection</label>
              <select
                id="collection-select"
                className="page-size-select"
                value={selectedCollection}
                onChange={(e) => setSelectedCollection(e.target.value)}
              >
                <option value="">— select —</option>
                {collections.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ flex: 1 }}>
              <label htmlFor="nlp-query">Query</label>
              <input
                id="nlp-query"
                className="modal-input"
                type="text"
                placeholder="Describe what you're looking for…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="form-field" style={{ flex: '0 0 90px' }}>
              <label htmlFor="k-select">Top-K</label>
              <select
                id="k-select"
                className="page-size-select"
                value={k}
                onChange={(e) => setK(Number(e.target.value))}
              >
                {K_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field" style={{ flex: '0 0 auto', justifyContent: 'flex-end' }}>
              <label style={{ visibility: 'hidden' }}>Go</label>
              <button className="btn btn-primary" type="submit" disabled={loading}>
                {loading ? 'Searching…' : 'Search'}
              </button>
            </div>
          </div>
          {error && (
            <div className="modal-error" style={{ marginTop: 8 }}>
              {error}
            </div>
          )}
        </form>

        {results !== null && (
          <div className="search-results">
            {results.length === 0 ? (
              <div className="empty-state">No matching documents found.</div>
            ) : (
              <>
                <div className="search-results-header">
                  {results.length} result{results.length !== 1 ? 's' : ''} for &ldquo;{query}&rdquo;
                </div>
                <div className="search-result-list">
                  {results.map((r, i) => (
                    <div key={i} className="search-result-card">
                      <div className="search-result-name">{r.name}</div>
                      <pre className="search-result-content">{JSON.stringify(r.content, null, 2)}</pre>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
