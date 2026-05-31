import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

const SKIP_KEY = 'nexum.skipDeleteConfirm';

export function shouldSkipConfirm(): boolean {
  return localStorage.getItem(SKIP_KEY) === 'true';
}

interface Props {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  showDontAskAgain?: boolean;
}

export function ConfirmModal({ message, onConfirm, onCancel, confirmLabel, showDontAskAgain = true }: Props) {
  const { t } = useTranslation();
  const [dontShowAgain, setDontShowAgain] = useState(false);

  // No custom label → the default "delete" action, which gets danger styling.
  const isDelete = confirmLabel === undefined;
  const label = confirmLabel ?? t('actions.delete');

  const handleConfirm = () => {
    if (showDontAskAgain && dontShowAgain) localStorage.setItem(SKIP_KEY, 'true');
    onConfirm();
  };

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal confirm-modal">
        <div className="modal__header">
          <h2 className="modal__title">{t('confirm.title')}</h2>
        </div>
        <div className="modal__body">
          <p className="confirm-modal__message">{message}</p>
          {showDontAskAgain && (
            <label className="confirm-modal__skip">
              <input
                type="checkbox"
                className="sig-checkbox"
                checked={dontShowAgain}
                onChange={(e) => setDontShowAgain(e.target.checked)}
              />
              {t('confirm.dontShowAgain')}
            </label>
          )}
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={onCancel}>{t('actions.cancel')}</button>
            <button
              className={isDelete ? 'btn btn--danger' : 'btn btn--primary'}
              onClick={handleConfirm}
            >
              {label}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
