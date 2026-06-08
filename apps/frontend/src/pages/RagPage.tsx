import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { useCollectionStore } from '../stores/collectionStore';
import { ragChat, type RagSource } from '../api/client';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  sources?: RagSource[];
};

export default function RagPage() {
  const navigate = useNavigate();
  const { collections } = useCollectionStore();
  const [selectedCollection, setSelectedCollection] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedCollection) {
      setError('Please select a collection.');
      return;
    }
    if (!input.trim()) return;

    const userMessage = input.trim();
    setInput('');
    setError('');
    setMessages((prev) => [...prev, { role: 'user', content: userMessage }]);
    setLoading(true);

    try {
      const { answer, sources } = await ragChat(selectedCollection, userMessage);
      setMessages((prev) => [...prev, { role: 'assistant', content: answer, sources }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed.');
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="docs-page">
      <div className="docs-header">
        <span className="breadcrumb-sep">RAG Chat</span>
      </div>
      <div className="rag-page-body">
        <div className="rag-messages">
          {messages.length === 0 && !loading && (
            <div className="empty-state">Select a collection and ask a question to get started.</div>
          )}
          <div className="search-result-list">
            {messages.map((msg, i) => (
              <div key={i} className={`search-result-card rag-message rag-message--${msg.role}`}>
                <div className="search-result-name">{msg.role === 'user' ? 'You' : 'Assistant'}</div>
                {msg.role === 'assistant' ? (
                  <div className="search-result-content search-result-content--markdown">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  <div
                    className="search-result-content"
                    style={{ whiteSpace: 'pre-wrap', maxHeight: 'none', overflowY: 'visible' }}
                  >
                    {msg.content}
                  </div>
                )}
                {msg.sources && msg.sources.length > 0 && (
                  <div className="rag-sources">
                    <span className="rag-sources-label">Sources:</span>
                    {msg.sources.map((src, j) => (
                      <button
                        key={j}
                        className="rag-source-chip rag-source-chip--link"
                        onClick={() =>
                          void navigate(
                            `/collections/${encodeURIComponent(selectedCollection)}?doc=${encodeURIComponent(src.name)}`,
                          )
                        }
                      >
                        {src.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {loading && (
              <div className="search-result-card rag-message rag-message--assistant">
                <div className="search-result-name">Assistant</div>
                <div className="search-result-content" style={{ color: 'var(--text-muted)' }}>
                  Thinking…
                </div>
              </div>
            )}
          </div>
          <div ref={messagesEndRef} />
        </div>

        <div className="rag-form-wrapper">
          <form className="search-form" onSubmit={(e) => void handleSubmit(e)}>
            <div className="search-form-row">
              <div className="form-field" style={{ flex: '0 0 220px' }}>
                <label htmlFor="rag-collection-select">Collection</label>
                <select
                  id="rag-collection-select"
                  className="page-size-select"
                  value={selectedCollection}
                  onChange={(e) => {
                    setSelectedCollection(e.target.value);
                    setMessages([]);
                    setError('');
                  }}
                >
                  <option value="">— select —</option>
                  {collections.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {error && (
              <div className="modal-error" style={{ marginTop: 8 }}>
                {error}
              </div>
            )}
            <div className="search-form-row" style={{ marginTop: 12 }}>
              <div className="form-field" style={{ flex: 1 }}>
                <input
                  className="modal-input"
                  type="text"
                  placeholder={selectedCollection ? 'Ask a question…' : 'Select a collection first'}
                  value={input}
                  disabled={!selectedCollection || loading}
                  onChange={(e) => setInput(e.target.value)}
                />
              </div>
              <div className="form-field" style={{ flex: '0 0 auto', justifyContent: 'flex-end' }}>
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={!selectedCollection || loading || !input.trim()}
                >
                  {loading ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
