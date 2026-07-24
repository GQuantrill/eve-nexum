import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '@phosphor-icons/react';
import { ALL_ICON_NAMES, iconComponent } from '../../utils/phosphorIcons';

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

  const matches = useMemo(() => {
    const q = iconQuery.trim().toLowerCase();
    const list = q ? ALL_ICON_NAMES.filter((n) => n.toLowerCase().includes(q)) : ALL_ICON_NAMES;
    return { shown: list.slice(0, ICON_RENDER_CAP), total: list.length };
  }, [iconQuery]);

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
          <div className="custom-label-dialog__icons">
            {matches.shown.map((name) => {
              const Icon = iconComponent(name);
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
