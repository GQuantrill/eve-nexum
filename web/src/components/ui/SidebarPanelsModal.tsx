import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '../../icons';

/**
 * Chooses which sidebar sections are shown. Hidden sections keep their place in
 * the saved order, so switching one back on returns it to where the user put it
 * rather than to the bottom.
 */
export function SidebarPanelsModal<Id extends string>({
  panels, isVisible, onToggle, onClose,
}: {
  /** Every section that could be shown, in the order the sidebar lists them. */
  panels:    ReadonlyArray<{ id: Id; title: string }>;
  isVisible: (id: Id) => boolean;
  onToggle:  (id: Id) => void;
  onClose:   () => void;
}) {
  const { t } = useTranslation();
  const shownCount = panels.filter((p) => isVisible(p.id)).length;

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal__header">
          <h2 className="modal__title">{t('sidebar.panelsTitle')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={16} weight="bold" />
          </button>
        </div>
        <div className="modal__body">
          <p className="sidebar-panels__hint">{t('sidebar.panelsHint')}</p>
          <div className="sidebar-panels__list">
            {panels.map(({ id, title }) => (
              <label key={id} className="sidebar-panels__item">
                <input
                  type="checkbox"
                  checked={isVisible(id)}
                  onChange={() => onToggle(id)}
                />
                <span>{title}</span>
              </label>
            ))}
          </div>
          {shownCount === 0 && (
            <p className="sidebar-panels__empty">{t('sidebar.panelsAllHidden')}</p>
          )}
          <div className="modal__actions">
            <button className="btn btn--primary" onClick={onClose}>{t('actions.close')}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
