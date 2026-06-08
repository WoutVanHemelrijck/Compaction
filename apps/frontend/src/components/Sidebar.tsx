import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useCollectionStore } from '../stores/collectionStore';
import { useAuthStore } from '../stores/authStore';
import Modal from './Modal';

export default function Sidebar() {
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [createError, setCreateError] = useState('');

  const { collections, loading, fetch, create, remove } = useCollectionStore();
  const { username, logout } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();

  // Determine the active collection from the URL
  const match = location.pathname.match(/^\/collections\/([^/]+)/);
  const activeCollection = match ? decodeURIComponent(match[1]) : null;

  useEffect(() => {
    void fetch();
  }, []);

  const filtered = collections.filter((c) => c.toLowerCase().includes(search.toLowerCase()));

  async function handleCreate() {
    if (!createName.trim()) {
      setCreateError('Name is required');
      return;
    }
    try {
      await create(createName.trim());
      setCreateName('');
      setCreateOpen(false);
      setCreateError('');
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create collection');
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await remove(deleteTarget);
      if (activeCollection === deleteTarget) void navigate('/collections');
      setDeleteTarget(null);
    } catch {
      // silently ignore — the item stays in the list
    }
  }

  function handleLogout() {
    void logout();
    void navigate('/login', { replace: true });
  }

  return (
    <aside className="sidebar">
      {/* Header */}
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <span className="logo-mark">DB</span>
          <span className="logo-num">9</span>
        </div>
        <span className="sidebar-title">SimpleDBMS</span>
      </div>

      {/* Collections section */}
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span>Collections</span>
          <button className="icon-btn" onClick={() => setCreateOpen(true)} title="New collection">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M6.5 1v11M1 6.5h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="search-wrap">
          <input
            className="search-input"
            type="text"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="collection-list">
          {loading && <div className="list-placeholder">Loading…</div>}
          {!loading && filtered.length === 0 && (
            <div className="list-placeholder">{search ? 'No matches' : 'No collections yet'}</div>
          )}
          {filtered.map((name) => (
            <div
              key={name}
              className={`collection-item ${activeCollection === name ? 'active' : ''}`}
              onClick={() => void navigate(`/collections/${encodeURIComponent(name)}`)}
              onMouseEnter={() => setHovered(name)}
              onMouseLeave={() => setHovered(null)}
            >
              <svg className="collection-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="2.5" width="12" height="2" rx="1" fill="currentColor" />
                <rect x="1" y="6" width="12" height="2" rx="1" fill="currentColor" opacity="0.6" />
                <rect x="1" y="9.5" width="12" height="2" rx="1" fill="currentColor" opacity="0.3" />
              </svg>
              <span className="collection-name">{name}</span>
              {hovered === name && (
                <button
                  className="delete-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(name);
                  }}
                  title="Delete collection"
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
      </div>

      {/* Query, NLP Search + RAG Chat nav */}
      <div className="sidebar-nav">
        <button
          className={`sidebar-nav-btn${location.pathname === '/query/sql' ? ' active' : ''}`}
          onClick={() => void navigate('/query/sql')}
          title="SQL Query"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2.5 2.5h9M2.5 6.5h6M2.5 10.5h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <span>SQL Query</span>
        </button>
        <button
          className={`sidebar-nav-btn${location.pathname === '/query/natural-language' ? ' active' : ''}`}
          onClick={() => void navigate('/query/natural-language')}
          title="Natural Language"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2.5 2.5h9M2.5 6.5h6M2.5 10.5h9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <span>Natural Language</span>
        </button>
        <button
          className={`sidebar-nav-btn${location.pathname === '/search' ? ' active' : ''}`}
          onClick={() => void navigate('/search')}
          title="NLP Search"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M9.5 9.5 13 13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <span>NLP Search</span>
        </button>
        <button
          className={`sidebar-nav-btn${location.pathname === '/rag' ? ' active' : ''}`}
          onClick={() => void navigate('/rag')}
          title="RAG Chat"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M2 2h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8l-3 2v-2H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
          <span>RAG Chat</span>
        </button>
      </div>

      {/* Footer */}
      <div className="sidebar-footer">
        <button className="user-btn" onClick={() => void navigate('/account')}>
          <div className="user-avatar">{username?.[0]?.toUpperCase() ?? '?'}</div>
          <span className="user-name">{username}</span>
        </button>
        <button
          className="icon-btn"
          onClick={handleLogout}
          title="Log out"
          style={{ marginLeft: 'auto', flexShrink: 0 }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M5 12H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h2M9.5 9.5 12 7l-2.5-2.5M12 7H5"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {/* Create collection modal */}
      <Modal
        open={createOpen}
        title="New Collection"
        confirmLabel="Create"
        onClose={() => {
          setCreateOpen(false);
          setCreateName('');
          setCreateError('');
        }}
        onConfirm={() => void handleCreate()}
      >
        <input
          className="modal-input"
          type="text"
          placeholder="Collection name"
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCreate();
          }}
          autoFocus
        />
        {createError && <div className="modal-error">{createError}</div>}
      </Modal>

      {/* Delete collection confirm modal */}
      <Modal
        open={deleteTarget !== null}
        title="Delete Collection"
        confirmLabel="Delete"
        confirmDestructive
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
      >
        <p className="modal-text">
          Are you sure you want to delete <strong>{deleteTarget}</strong>? All documents inside it will be permanently
          removed.
        </p>
      </Modal>
    </aside>
  );
}
