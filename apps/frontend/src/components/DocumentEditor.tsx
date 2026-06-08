import { useEffect, useState } from 'react';
import { fetchDocumentContent, updateDocument } from '../api/client';
import FieldBuilder from './FieldBuilder';

interface Props {
  collectionName: string;
  documentName: string | null;
  onSaved?: () => void;
}

export default function DocumentEditor({ collectionName, documentName, onSaved }: Props) {
  const [content, setContent] = useState<Record<string, unknown> | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState<Record<string, unknown>>({});
  const [editorKey, setEditorKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!documentName) {
      setContent(null);
      setEditing(false);
      setError('');
      return;
    }
    setLoading(true);
    setEditing(false);
    setError('');
    fetchDocumentContent(collectionName, documentName)
      .then((c) => {
        setContent(c);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to load');
        setLoading(false);
      });
  }, [collectionName, documentName]);

  function startEdit() {
    const initial = content ?? {};
    setEditContent(initial);
    setEditorKey((k) => k + 1);
    setEditing(true);
    setError('');
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      await updateDocument(collectionName, documentName!, editContent);
      setContent(editContent);
      setEditing(false);
      onSaved?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (!documentName) {
    return (
      <div className="editor-placeholder">
        <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
          <rect x="4" y="5" width="22" height="27" rx="3" stroke="#cbd5e1" strokeWidth="1.8" />
          <path d="M9 14h12M9 19h8M9 24h5" stroke="#cbd5e1" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M22 5v6h6" stroke="#cbd5e1" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
        <p>Select a document to view its contents</p>
      </div>
    );
  }

  if (loading) {
    return <div className="editor-loading">Loading…</div>;
  }

  return (
    <div className="editor">
      <div className="editor-header">
        <span className="editor-doc-name">{documentName}</span>
        <div className="editor-actions">
          {editing ? (
            <>
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setEditing(false);
                  setError('');
                }}
              >
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <button className="btn btn-secondary" onClick={startEdit}>
              Edit
            </button>
          )}
        </div>
      </div>
      {error && <div className="editor-error">{error}</div>}
      {editing ? (
        <div className="editor-builder">
          <FieldBuilder key={editorKey} initialValue={content ?? {}} onChange={setEditContent} />
        </div>
      ) : (
        <pre className="editor-content">{JSON.stringify(content, null, 2)}</pre>
      )}
    </div>
  );
}
