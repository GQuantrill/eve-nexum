import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trans, useTranslation } from 'react-i18next';
import { notifyPermissionChanged } from '../../hooks/useNotificationPermission';

const ASKED_KEY = 'nexum.proximityOptInAsked';

/**
 * One-time consent modal shown on first login asking whether to enable
 * desktop notifications for proximity alerts (incursions / insurgencies).
 *
 * Skipped if:
 *  - The browser doesn't support the Notification API
 *  - Permission is already granted or already denied
 *  - The user has already responded to this prompt (tracked in localStorage)
 */
export function ProximityOptInModal() {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'default')  return;
    if (localStorage.getItem(ASKED_KEY))         return;
    setShow(true);
  }, []);

  function dismiss() {
    localStorage.setItem(ASKED_KEY, '1');
    setShow(false);
  }

  function enable() {
    // Close the modal first — the user has committed to a choice by
    // clicking, regardless of what the OS prompt does next. If we leave
    // dismiss() inside the Promise chain and requestPermission either
    // throws or returns the legacy callback-style undefined, the modal
    // gets stuck open with no obvious recovery.
    dismiss();
    try {
      const maybe = Notification.requestPermission() as unknown;
      if (maybe && typeof (maybe as Promise<unknown>).then === 'function') {
        (maybe as Promise<unknown>).finally(() => notifyPermissionChanged());
      } else {
        // Legacy callback-style API — the browser has already updated
        // Notification.permission by the time the call returns.
        notifyPermissionChanged();
      }
    } catch {
      notifyPermissionChanged();
    }
  }

  if (!show) return null;

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) dismiss(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal__header">
          <h2 className="modal__title">{t('proximityOptIn.title')}</h2>
        </div>

        <div className="modal__body proximity-optin__body">
          <p><Trans i18nKey="proximityOptIn.body" /></p>
          <p className="proximity-optin__sub"><Trans i18nKey="proximityOptIn.sub" /></p>

          <div className="modal__actions">
            <button type="button" className="btn btn--ghost" onClick={dismiss}>
              {t('proximityOptIn.maybeLater')}
            </button>
            <button type="button" className="btn btn--primary" onClick={enable}>
              {t('proximityOptIn.enable')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
