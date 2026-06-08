import { useState } from 'react';
import { createDocument } from '../api/client';
import FieldBuilder from './FieldBuilder';

interface Props {
  collectionName: string;
  onCreated: (name: string) => void;
  onCancel: () => void;
}

export default function DocumentCreator({ collectionName, onCreated, onCancel }: Props) {
  const [name, setName] = useState('');
  const [content, setContent] = useState<Record<string, unknown>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleCreate() {
    if (!name.trim()) {
      setError('Document name is required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await createDocument(collectionName, name.trim(), content);
      onCreated(name.trim());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create document');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="editor">
      <div className="editor-header">
        <input
          className="editor-name-input"
          placeholder="document name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCreate();
          }}
          autoFocus
        />
        <div className="editor-actions">
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => void handleCreate()} disabled={saving}>
            {saving ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
      {error && <div className="editor-error">{error}</div>}
      <div className="editor-builder">
        <FieldBuilder onChange={setContent} />
      </div>
    </div>
  );
}
