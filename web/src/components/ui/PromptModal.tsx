import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

interface Props {
  title:         string;
  message?:      string;
  defaultValue?: string;
  placeholder?:  string;
  confirmLabel?: string;
  onConfirm:     (value: string) => void;
  onCancel:      () => void;
}

// Modal replacement for native prompt() — same purpose but composable with
// the rest of the app's styling and z-index stacking.
export function PromptModal({ title, message, defaultValue = '', placeholder, confirmLabel, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed) onConfirm(trimmed);
  };

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal confirm-modal">
        <div className="modal__header">
          <h2 className="modal__title">{title}</h2>
        </div>
        <div className="modal__body">
          {message && <p className="confirm-modal__message">{message}</p>}
          <input
            ref={inputRef}
            className="sig-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') onCancel();
            }}
            placeholder={placeholder}
            style={{ width: '100%', marginTop: 8 }}
          />
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={onCancel}>{t('actions.cancel')}</button>
            <button className="btn btn--primary" onClick={submit} disabled={!value.trim()}>
              {confirmLabel ?? t('actions.ok')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
