import { useState } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

type FieldType = 'string' | 'number' | 'boolean' | 'null' | 'object';

interface Field {
  id: string;
  key: string;
  value: string;
  type: FieldType;
  children?: Field[]; // only when type === 'object'
  collapsed?: boolean; // only when type === 'object'
}

let _uid = 0;
function uid() {
  return String(_uid++);
}
function emptyField(): Field {
  return { id: uid(), key: '', value: '', type: 'string' };
}

// ── Serialisation ──────────────────────────────────────────────────────────────

function fieldsToJson(fields: Field[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const f of fields) {
    if (!f.key.trim()) continue;
    switch (f.type) {
      case 'string':
        result[f.key] = f.value;
        break;
      case 'number': {
        const n = Number(f.value);
        result[f.key] = isNaN(n) ? 0 : n;
        break;
      }
      case 'boolean':
        result[f.key] = f.value === 'true';
        break;
      case 'null':
        result[f.key] = null;
        break;
      case 'object':
        result[f.key] = fieldsToJson(f.children ?? []);
        break;
    }
  }
  return result;
}

function jsonToFields(obj: Record<string, unknown>): Field[] {
  const entries = Object.entries(obj);
  if (entries.length === 0) return [emptyField()];
  return entries.map(([key, value]) => {
    if (value === null) return { id: uid(), key, value: '', type: 'null' };
    if (typeof value === 'boolean') return { id: uid(), key, value: String(value), type: 'boolean' };
    if (typeof value === 'number') return { id: uid(), key, value: String(value), type: 'number' };
    if (typeof value === 'object' && !Array.isArray(value))
      return { id: uid(), key, value: '', type: 'object', children: jsonToFields(value as Record<string, unknown>) };
    return { id: uid(), key, value: JSON.stringify(value), type: 'string' };
  });
}

// ── Recursive row renderer ─────────────────────────────────────────────────────

function FieldRows({
  fields,
  onChange,
  depth = 0,
}: {
  fields: Field[];
  onChange: (next: Field[]) => void;
  depth?: number;
}) {
  function patch(id: string, changes: Partial<Field>) {
    onChange(fields.map((f) => (f.id === id ? { ...f, ...changes } : f)));
  }

  function removeField(id: string) {
    const next = fields.filter((f) => f.id !== id);
    onChange(next.length ? next : [emptyField()]);
  }

  function addField() {
    onChange([...fields, emptyField()]);
  }

  const indentStyle = depth > 0 ? { paddingLeft: depth * 16 } : undefined;

  return (
    <div className="fb-rows" style={indentStyle}>
      {depth > 0 && <div className="fb-indent-line" />}

      {fields.map((f) => (
        <div key={f.id} className="fb-field-group">
          {/* Main row */}
          <div className="fb-row">
            {/* Collapse chevron for object type */}
            {f.type === 'object' ? (
              <button
                type="button"
                className={`fb-collapse-btn${f.collapsed ? ' collapsed' : ''}`}
                onClick={() => patch(f.id, { collapsed: !f.collapsed })}
                title={f.collapsed ? 'Expand' : 'Collapse'}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path
                    d="M2 3.5l3 3 3-3"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : (
              <span className="fb-collapse-spacer" />
            )}

            <input
              className="fb-input fb-col-key"
              placeholder="field name"
              value={f.key}
              onChange={(e) => patch(f.id, { key: e.target.value })}
            />

            {/* Value column */}
            {f.type === 'object' ? (
              <span className="fb-col-val" />
            ) : f.type === 'boolean' ? (
              <select
                className="fb-input fb-col-val"
                value={f.value || 'true'}
                onChange={(e) => patch(f.id, { value: e.target.value })}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : f.type === 'null' ? (
              <input className="fb-input fb-col-val" disabled placeholder="null" />
            ) : (
              <input
                className="fb-input fb-col-val"
                placeholder={f.type === 'number' ? '0' : 'value'}
                type={f.type === 'number' ? 'number' : 'text'}
                value={f.value}
                onChange={(e) => patch(f.id, { value: e.target.value })}
              />
            )}

            <select
              className="fb-type-select fb-col-type"
              value={f.type}
              onChange={(e) => {
                const type = e.target.value as FieldType;
                if (type === 'object') {
                  patch(f.id, { type, value: '', children: [emptyField()], collapsed: false });
                } else {
                  patch(f.id, { type, value: type === 'boolean' ? 'true' : '', children: undefined });
                }
              }}
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">bool</option>
              <option value="null">null</option>
              <option value="object">object</option>
            </select>

            <button type="button" className="fb-remove-btn" onClick={() => removeField(f.id)} title="Remove field">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {/* Nested children */}
          {f.type === 'object' && !f.collapsed && (
            <div className="fb-children">
              <FieldRows
                fields={f.children ?? [emptyField()]}
                onChange={(newChildren) => patch(f.id, { children: newChildren })}
                depth={depth + 1}
              />
            </div>
          )}
        </div>
      ))}

      <div className="fb-footer">
        <button type="button" className="fb-add-btn" onClick={addField}>
          + Add field
        </button>
      </div>
    </div>
  );
}

// ── Public component ───────────────────────────────────────────────────────────

interface Props {
  onChange: (json: Record<string, unknown>) => void;
  initialValue?: Record<string, unknown>;
}

export default function FieldBuilder({ onChange, initialValue }: Props) {
  const [fields, setFields] = useState<Field[]>(() =>
    initialValue && Object.keys(initialValue).length > 0 ? jsonToFields(initialValue) : [emptyField()],
  );
  const [rawMode, setRawMode] = useState(false);
  const [rawJson, setRawJson] = useState('');
  const [rawError, setRawError] = useState('');

  function updateFields(next: Field[]) {
    setFields(next);
    onChange(fieldsToJson(next));
  }

  function openRaw() {
    setRawJson(JSON.stringify(fieldsToJson(fields), null, 2));
    setRawError('');
    setRawMode(true);
  }

  function closeRaw() {
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      setFields(jsonToFields(parsed));
      onChange(parsed);
      setRawMode(false);
      setRawError('');
    } catch {
      setRawError('Invalid JSON — fix it before switching back');
    }
  }

  function handleRawChange(val: string) {
    setRawJson(val);
    setRawError('');
    try {
      onChange(JSON.parse(val) as Record<string, unknown>);
    } catch {
      /* wait */
    }
  }

  /* ── Raw JSON mode ── */
  if (rawMode) {
    return (
      <div className="field-builder">
        <textarea
          className="modal-textarea"
          rows={8}
          value={rawJson}
          onChange={(e) => handleRawChange(e.target.value)}
          spellCheck={false}
          autoFocus
        />
        {rawError && <div className="modal-error">{rawError}</div>}
        <button type="button" className="fb-raw-toggle" onClick={closeRaw}>
          ← Back to field builder
        </button>
      </div>
    );
  }

  /* ── Builder mode ── */
  return (
    <div className="field-builder">
      <div className="fb-toolbar">
        <div className="fb-header">
          <span className="fb-collapse-spacer" />
          <span className="fb-col-key">Key</span>
          <span className="fb-col-val">Value</span>
          <span className="fb-col-type">Type</span>
        </div>
        <button type="button" className="fb-raw-toggle" onClick={openRaw}>
          Edit as JSON ↗
        </button>
      </div>

      <FieldRows fields={fields} onChange={updateFields} />
    </div>
  );
}
