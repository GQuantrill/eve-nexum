import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '../../icons';
import { usePhosphorIcons } from '../../utils/phosphorIcons';

interface Props {
  onPick:  (iconName: string) => void;
  onClose: () => void;
  current?: string | null;
}

// How many icons to render at once — the full Phosphor set is ~1500, so the
// grid shows the first N matches and nudges the user to search for the rest.
const ICON_RENDER_CAP = 120;

// Single-icon picker (a wormhole-connection flag). Modelled on
// CustomLabelDialog and reuses its dialog/grid CSS so it looks consistent —
// picking an icon calls onPick then closes.
export function IconPickerDialog({ onPick, onClose, current }: Props) {
  const { t } = useTranslation();
  const [iconQuery, setIconQuery] = useState('');
  // Phosphor is lazy-loaded on first open (it's a large chunk) — `names` fills in
  // once it's ready, and the hook re-renders us then.
  const { ready, names, resolve } = usePhosphorIcons();

  const matches = useMemo(() => {
    const q = iconQuery.trim().toLowerCase();
    const list = q ? names.filter((n) => n.toLowerCase().includes(q)) : names;
    return { shown: list.slice(0, ICON_RENDER_CAP), total: list.length };
  }, [iconQuery, names]);

  const pick = (name: string) => { onPick(name); onClose(); };

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal custom-label-dialog">
        <div className="modal__header">
          <h2 className="modal__title">{t('iconPicker.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={16} weight="bold" />
          </button>
        </div>
        <div className="modal__body">
          <input
            className="sig-input"
            value={iconQuery}
            autoFocus
            placeholder={t('iconPicker.search')}
            onChange={(e) => setIconQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
            style={{ width: '100%' }}
          />
          {!ready && <p className="custom-label-dialog__hint">{t('iconPicker.loading')}</p>}
          <div className="custom-label-dialog__icons">
            {matches.shown.map((name) => {
              const Icon = resolve(name);
              if (!Icon) return null;
              return (
                <button
                  key={name}
                  className={`custom-label-dialog__icon${name === current ? ' custom-label-dialog__icon--active' : ''}`}
                  title={name}
                  onClick={() => pick(name)}
                >
                  <Icon size={18} weight={name === current ? 'fill' : 'regular'} />
                </button>
              );
            })}
          </div>
          {matches.total > matches.shown.length && (
            <p className="custom-label-dialog__hint">
              {t('iconPicker.more')}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
