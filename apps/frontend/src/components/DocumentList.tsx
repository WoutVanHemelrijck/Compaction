import { useState } from 'react';

interface Props {
  documents: string[];
  loading: boolean;
  selectedDoc: string | null;
  onSelect: (name: string) => void;
  onDelete: (name: string) => void;
}

export default function DocumentList({ documents, loading, selectedDoc, onSelect, onDelete }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);

  if (loading) {
    return <div className="list-placeholder">Loading documents…</div>;
  }

  if (documents.length === 0) {
    return (
      <div className="empty-state">
        <p>No documents yet.</p>
        <p>Click "+ New Document" to get started.</p>
      </div>
    );
  }

  return (
    <div className="doc-list">
      {documents.map((name) => (
        <div
          key={name}
          className={`doc-item ${selectedDoc === name ? 'active' : ''}`}
          onClick={() => onSelect(name)}
          onMouseEnter={() => setHovered(name)}
          onMouseLeave={() => setHovered(null)}
        >
          <svg className="doc-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 1h6l3 3v9H3V1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            <path d="M9 1v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            <path d="M5 7h4M5 9.5h2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <span className="doc-name">{name}</span>
          {hovered === name && (
            <button
              className="delete-btn"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(name);
              }}
              title="Delete document"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M2 3h8M5 3V2h2v1M4.5 3l.5 6M7.5 3l-.5 6"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
