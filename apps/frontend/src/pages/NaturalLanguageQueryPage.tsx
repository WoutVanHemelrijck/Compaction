import { useState } from 'react';
import { executeNaturalLanguageQuery, type QueryExecutionResponse } from '../api/client';

export default function NaturalLanguageQueryPage() {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [response, setResponse] = useState<QueryExecutionResponse | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const trimmed = input.trim();
    if (!trimmed) {
      setError('Please enter a natural language prompt.');
      return;
    }

    setLoading(true);
    setError('');
    setResponse(null);

    try {
      const data = await executeNaturalLanguageQuery(trimmed);
      setResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setLoading(false);
    }
  }

  const resultText =
    response?.result === undefined
      ? 'No result payload returned (query may have been executed successfully).'
      : JSON.stringify(response.result, null, 2);

  return (
    <div className="docs-page">
      <div className="docs-header">
        <span className="breadcrumb-sep">Natural Language Query</span>
      </div>

      <div className="search-page-body">
        <form className="search-form" onSubmit={(e) => void handleSubmit(e)}>
          <div className="search-form-row">
            <div className="form-field" style={{ flex: 1 }}>
              <label htmlFor="query-input">Prompt</label>
              <textarea
                id="query-input"
                className="modal-input"
                placeholder="Example: show me the last 5 users"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={6}
                style={{ resize: 'vertical', minHeight: 120 }}
                disabled={loading}
              />
            </div>
          </div>

          <div className="search-form-row" style={{ marginTop: 12 }}>
            <div className="form-field" style={{ flex: '0 0 auto', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" type="submit" disabled={loading}>
                {loading ? 'Running...' : 'Run Query'}
              </button>
            </div>
          </div>

          {error && (
            <div className="modal-error" style={{ marginTop: 8 }}>
              {error}
            </div>
          )}
        </form>

        {response !== null && (
          <div className="search-results">
            <div className="search-result-list">
              <div className="search-result-card">
                <div className="search-result-name">Executed Query</div>
                <pre className="search-result-content">{response.query ?? '(no query returned)'}</pre>
              </div>

              <div className="search-result-card">
                <div className="search-result-name">Result</div>
                <pre className="search-result-content">{resultText}</pre>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
