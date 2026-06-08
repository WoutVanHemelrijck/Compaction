interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
  confirmDestructive?: boolean;
  wide?: boolean;
  children?: React.ReactNode;
}

export default function Modal({
  open,
  title,
  onClose,
  onConfirm,
  confirmLabel = 'Confirm',
  confirmDestructive = false,
  wide = false,
  children,
}: ModalProps) {
  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal${wide ? ' modal-wide' : ''}`}>
        <h3 className="modal-title">{title}</h3>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className={`btn ${confirmDestructive ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
