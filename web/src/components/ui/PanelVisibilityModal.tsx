import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '../../icons';

/**
 * Chooses which panels are shown, for a stack of them. Hidden panels keep their
 * place in the saved order, so switching one back on returns it to where the
 * user put it rather than to the bottom. Used by both the sidebar and the
 * system panel, which have the same problem and should behave the same way.
 */
export function PanelVisibilityModal<Id extends string>({
  title, hint, panels, isVisible, onToggle, onClose,
}: {
  title: string;
  hint:  string;
  /** Every panel that could be shown, in the order the stack lists them. */
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
          <h2 className="modal__title">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={16} weight="bold" />
          </button>
        </div>
        <div className="modal__body">
          <p className="panel-visibility__hint">{hint}</p>
          <div className="panel-visibility__list">
            {panels.map(({ id, title }) => (
              <label key={id} className="panel-visibility__item">
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
            <p className="panel-visibility__empty">{t('sidebar.panelsAllHidden')}</p>
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
