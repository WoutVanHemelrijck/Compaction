import { useEffect, useState, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { fetchDocumentsPaged, deleteDocument } from '../api/client';
import DocumentList from '../components/DocumentList';
import DocumentEditor from '../components/DocumentEditor';
import DocumentCreator from '../components/DocumentCreator';
import Modal from '../components/Modal';
import '../styles/components.css';

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export default function DocumentsPage() {
  const { name: rawName } = useParams<{ name: string }>();
  const collectionName = decodeURIComponent(rawName ?? '');
  const [searchParams] = useSearchParams();

  const [documents, setDocuments] = useState<string[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [pageSize, setPageSize] = useState(25);
  // Stack of cursors: [null, cursor1, cursor2, ...]. Current page = last element.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  const [total, setTotal] = useState(0);

  const [isCreating, setIsCreating] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const isFirstPage = cursors.length === 1;

  const loadDocuments = useCallback(
    async (cursor: string | null, limit: number) => {
      setLoading(true);
      try {
        const result = await fetchDocumentsPaged(collectionName, limit, cursor ?? undefined);
        setDocuments(result.documentNames);
        setHasNextPage(result.hasNextPage);
        setNextCursor(result.nextCursor);
        setTotal(result.total);
        setRangeStart(result.rangeStart);
        setRangeEnd(result.rangeEnd);
      } catch {
        setDocuments([]);
        setHasNextPage(false);
        setNextCursor(null);
        setTotal(0);
        setRangeStart(0);
        setRangeEnd(0);
      } finally {
        setLoading(false);
      }
    },
    [collectionName],
  );

  useEffect(() => {
    setSelectedDoc(null);
    setIsCreating(false);
    setCursors([null]);
    void loadDocuments(null, pageSize);
  }, [collectionName, loadDocuments]);

  // Auto-select a document when navigated here via ?doc= query param (e.g. from RAG source chips).
  useEffect(() => {
    const docParam = searchParams.get('doc');
    if (docParam && documents.includes(docParam)) {
      setIsCreating(false);
      setSelectedDoc(docParam);
    }
  }, [documents, searchParams]);

  function handleNext() {
    const newCursors = [...cursors, nextCursor];
    setCursors(newCursors);
    void loadDocuments(nextCursor, pageSize);
  }

  function handlePrev() {
    const newCursors = cursors.slice(0, -1);
    setCursors(newCursors);
    void loadDocuments(newCursors[newCursors.length - 1] ?? null, pageSize);
  }

  function handlePageSizeChange(size: number) {
    setPageSize(size);
    setCursors([null]);
    void loadDocuments(null, size);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteDocument(collectionName, deleteTarget);
      if (selectedDoc === deleteTarget) setSelectedDoc(null);
      setCursors([null]);
      await loadDocuments(null, pageSize);
      setDeleteTarget(null);
    } catch {
      setDeleteTarget(null);
    }
  }

  return (
    <div className="docs-page">
      {/* Header */}
      <div className="docs-header">
        <div className="breadcrumb">
          <span className="breadcrumb-sep">Collections</span>
          <span className="breadcrumb-sep">/</span>
          <span className="breadcrumb-current">{collectionName}</span>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => {
            setSelectedDoc(null);
            setIsCreating(true);
          }}
        >
          + New Document
        </button>
      </div>

      {/* Split layout */}
      <div className="docs-layout">
        <div className="docs-list-panel">
          <div className="doc-list-scroll">
            <DocumentList
              documents={documents}
              loading={loading}
              selectedDoc={selectedDoc}
              onSelect={(name) => {
                setIsCreating(false);
                setSelectedDoc(name);
              }}
              onDelete={(name) => setDeleteTarget(name)}
            />
          </div>
          <div className="pagination-row">
            <span className="pagination-range">
              {total === 0 ? '0' : `${rangeStart}–${rangeEnd}`} of {total}
            </span>
            <div className="pagination-controls">
              <button className="btn btn-secondary pagination-btn" disabled={isFirstPage} onClick={handlePrev}>
                ← Prev
              </button>
              <select
                className="page-size-select"
                value={pageSize}
                onChange={(e) => handlePageSizeChange(Number(e.target.value))}
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <button className="btn btn-secondary pagination-btn" disabled={!hasNextPage} onClick={handleNext}>
                Next →
              </button>
            </div>
          </div>
        </div>
        <div className="docs-editor-panel">
          {isCreating ? (
            <DocumentCreator
              collectionName={collectionName}
              onCreated={(name) => {
                void (async () => {
                  setCursors([null]);
                  await loadDocuments(null, pageSize);
                  setIsCreating(false);
                  setSelectedDoc(name);
                })();
              }}
            />
          ) : (
            <DocumentEditor collectionName={collectionName} documentName={selectedDoc} />
          )}
        </div>
      </div>

      {/* Delete document confirm modal */}
      <Modal
        open={deleteTarget !== null}
        title="Delete Document"
        confirmLabel="Delete"
        confirmDestructive
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
      >
        <p className="modal-text">
          Are you sure you want to delete <strong>{deleteTarget}</strong>? This action cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
