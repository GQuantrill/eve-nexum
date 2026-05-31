import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { TrashIcon, PlusIcon } from '@phosphor-icons/react';
import { useCustomIntel, MAX_CUSTOM_INTEL } from '../../hooks/useCustomIntel';
import type { CustomIntel } from '../../types';

const DEFAULT_COLOR = '#6ea0ff';

export function CustomIntelBlock() {
  const { t } = useTranslation();
  const [items, setItems] = useCustomIntel();
  // Tracks the id of the most recently added row so the label input can
  // grab focus + auto-select on mount. Cleared after the first focus so a
  // later re-render doesn't keep stealing focus.
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);

  function addItem() {
    if (items.length >= MAX_CUSTOM_INTEL) return;
    const next: CustomIntel = { id: uuid(), label: t('customIntel.newItem'), color: DEFAULT_COLOR };
    setItems([...items, next]);
    setAutoFocusId(next.id);
  }

  function updateItem(id: string, patch: Partial<Omit<CustomIntel, 'id'>>) {
    setItems(items.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function removeItem(id: string) {
    setItems(items.filter((it) => it.id !== id));
  }

  const atCap = items.length >= MAX_CUSTOM_INTEL;

  return (
    <div className="custom-intel">
      <div className="map-sidebar__label">{t('customIntel.title')}</div>
      <div className="map-sidebar__hint">
        {t('customIntel.hint')}
      </div>

      {items.length > 0 && (
        <div className="custom-intel__list">
          {items.map((it) => (
            <div key={it.id} className="custom-intel__row">
              {/* The native colour input renders the small coloured swatch
                  + opens the OS picker on click. Wrapping in a label keeps
                  the click target generous without any extra CSS. */}
              <label className="custom-intel__swatch" style={{ background: it.color }}>
                <input
                  type="color"
                  value={it.color}
                  onChange={(e) => updateItem(it.id, { color: e.target.value })}
                />
              </label>
              <input
                type="text"
                className="custom-intel__label-input"
                value={it.label}
                maxLength={32}
                onChange={(e) => updateItem(it.id, { label: e.target.value })}
                placeholder={t('customIntel.labelPlaceholder')}
                ref={(el) => {
                  // Ref callback fires on mount with the element. When this
                  // row is the one we just created, grab focus and pre-select
                  // the default label so typing replaces it immediately.
                  if (el && autoFocusId === it.id) {
                    el.focus();
                    el.select();
                    setAutoFocusId(null);
                  }
                }}
              />
              <button
                type="button"
                className="custom-intel__remove"
                onClick={() => removeItem(it.id)}
                title={t('customIntel.remove')}
              >
                <TrashIcon size={14} weight="regular" />
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        className="map-sidebar__action"
        onClick={addItem}
        disabled={atCap}
        title={atCap ? t('customIntel.max', { count: MAX_CUSTOM_INTEL }) : undefined}
      >
        <PlusIcon size={14} weight="bold" /> {t('customIntel.add')}
      </button>
    </div>
  );
}
