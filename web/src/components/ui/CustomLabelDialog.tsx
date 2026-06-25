import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '@phosphor-icons/react';
import {
  MAX_CUSTOM_LABELS, DEFAULT_CUSTOM_LABEL_COLOR,
  parseCustomLabel, encodeTextLabel, encodeIconLabel, labelTextColor,
} from '../../data/labels';
import { ALL_ICON_NAMES, iconComponent } from '../../utils/phosphorIcons';

interface Props {
  customLabels: string[];                 // raw 't:'/'i:' entries
  onChange:     (next: string[]) => void; // persisted by the caller (updateSystem)
  onClose:      () => void;
}

// How many icons to render at once — the full Phosphor set is ~1500, so the
// grid shows the first N matches and nudges the user to search for the rest.
const ICON_RENDER_CAP = 120;

export function CustomLabelDialog({ customLabels, onChange, onClose }: Props) {
  const { t } = useTranslation();
  const [labels, setLabels] = useState<string[]>(customLabels);
  const [text, setText]     = useState('');
  const [iconQuery, setIconQuery] = useState('');
  // Colour applied to the next label added; also the starting value for the
  // per-chip recolour inputs.
  const [color, setColor]   = useState<string>(DEFAULT_CUSTOM_LABEL_COLOR);

  const full = labels.length >= MAX_CUSTOM_LABELS;

  const apply = (next: string[]) => { setLabels(next); onChange(next); };
  const addText = () => {
    const v = text.trim();
    if (!v || full) return;
    apply([...labels, encodeTextLabel(v.slice(0, 40), color)]);
    setText('');
  };
  const addIcon = (name: string) => { if (!full) apply([...labels, encodeIconLabel(name, color)]); };
  const removeAt = (i: number) => apply(labels.filter((_, j) => j !== i));
  // Recolour an existing chip — re-encode it with the new colour, keeping kind + value.
  const recolorAt = (i: number, c: string) => {
    const parsed = parseCustomLabel(labels[i]);
    if (!parsed) return;
    const next = parsed.kind === 'text' ? encodeTextLabel(parsed.value, c) : encodeIconLabel(parsed.value, c);
    apply(labels.map((raw, j) => (j === i ? next : raw)));
  };

  const matches = useMemo(() => {
    const q = iconQuery.trim().toLowerCase();
    const list = q ? ALL_ICON_NAMES.filter((n) => n.toLowerCase().includes(q)) : ALL_ICON_NAMES;
    return { shown: list.slice(0, ICON_RENDER_CAP), total: list.length };
  }, [iconQuery]);

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal custom-label-dialog">
        <div className="modal__header">
          <h2 className="modal__title">{t('labelsDialog.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={16} weight="bold" />
          </button>
        </div>
        <div className="modal__body">
          {/* Current custom labels */}
          {labels.length > 0 && (
            <div className="custom-label-dialog__current">
              {labels.map((raw, i) => {
                const parsed = parseCustomLabel(raw);
                const Icon = parsed?.kind === 'icon' ? iconComponent(parsed.value) : null;
                const bg = parsed?.color || undefined;
                return (
                  <span
                    key={i}
                    className={`custom-label-dialog__chip${bg ? ' custom-label-dialog__chip--coloured' : ''}`}
                    style={bg ? { background: bg, borderColor: bg, color: labelTextColor(bg) } : undefined}
                  >
                    {Icon ? <Icon size={13} weight="fill" /> : <span>{parsed?.value ?? raw}</span>}
                    {/* Recolour swatch — native colour input, label as the visible swatch. */}
                    <label className="custom-label-dialog__chip-color" title={t('labelsDialog.colour')}>
                      <input
                        type="color"
                        value={parsed?.color || DEFAULT_CUSTOM_LABEL_COLOR}
                        onChange={(e) => recolorAt(i, e.target.value)}
                      />
                    </label>
                    <button className="custom-label-dialog__chip-x" onClick={() => removeAt(i)} aria-label={t('labelsDialog.remove')}>
                      <XIcon size={11} weight="bold" />
                    </button>
                  </span>
                );
              })}
            </div>
          )}

          <p className="custom-label-dialog__hint">{t('labelsDialog.max', { n: MAX_CUSTOM_LABELS })}</p>

          {/* Add area — wrapped so a single title explains why it's disabled at
              the cap (a `title` on a disabled control itself won't show on hover;
              on the enclosing element it does). */}
          <div
            className="custom-label-dialog__add-area"
            aria-disabled={full}
            title={full ? t('labelsDialog.maxReached', { n: MAX_CUSTOM_LABELS }) : undefined}
          >
          {/* Colour for the next label added (text or icon). */}
          <label className="custom-label-dialog__color-row">
            <span>{t('labelsDialog.colour')}</span>
            <input type="color" value={color} disabled={full} onChange={(e) => setColor(e.target.value)} />
          </label>

          {/* Add a text label */}
          <div className="custom-label-dialog__add-text">
            <input
              className="sig-input"
              value={text}
              maxLength={40}
              disabled={full}
              placeholder={t('labelsDialog.textPlaceholder')}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addText(); if (e.key === 'Escape') onClose(); }}
              style={{ flex: 1 }}
            />
            <button className="btn btn--primary" onClick={addText} disabled={full || !text.trim()}>
              {t('labelsDialog.addText')}
            </button>
          </div>

          {/* Icon picker */}
          <input
            className="sig-input"
            value={iconQuery}
            disabled={full}
            placeholder={t('labelsDialog.searchIcons')}
            onChange={(e) => setIconQuery(e.target.value)}
            style={{ width: '100%', marginTop: 10 }}
          />
          <div className="custom-label-dialog__icons" aria-disabled={full}>
            {matches.shown.map((name) => {
              const Icon = iconComponent(name);
              if (!Icon) return null;
              return (
                <button
                  key={name}
                  className="custom-label-dialog__icon"
                  title={name}
                  disabled={full}
                  onClick={() => addIcon(name)}
                >
                  <Icon size={18} weight="regular" />
                </button>
              );
            })}
          </div>
          {matches.total > matches.shown.length && (
            <p className="custom-label-dialog__hint">
              {t('labelsDialog.moreIcons', { shown: matches.shown.length, total: matches.total })}
            </p>
          )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
