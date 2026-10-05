import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { TrashIcon, PlusIcon } from '../../icons';
import { DynamicIcon } from '../DynamicIcon';
import { IconPickerDialog } from './IconPickerDialog';
import { MAX_FLAG_PRESETS, FLAG_NAME_MAX } from '../../hooks/useFlagPresets';
import type { FlagPreset } from '../../types';
import styles from './CustomIntelBlock.module.css';

const DEFAULT_COLOR = '#f0a030';   // the same amber the flag colour input defaults to
const DEFAULT_ICON  = 'TagIcon';

/**
 * Edit a list of connection-flag presets.
 *
 * Deliberately controlled rather than owning its own storage, because the same
 * editor serves two homes: the pilot's personal list (a user setting, written
 * through on every keystroke) and the admin's org list (loaded and saved
 * explicitly against the API). Only the owner differs.
 *
 * Modelled on CustomIntelBlock, with an icon added — so the colour swatch, the
 * cap-disabled add button and the auto-focus-the-new-row behaviour all work the
 * way they already do elsewhere.
 */
export function FlagPresetEditor({ items, onChange, disabled }: {
  items: FlagPreset[];
  onChange: (next: FlagPreset[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);
  // Which row's icon is being chosen; null when the picker is closed.
  const [pickingFor, setPickingFor] = useState<string | null>(null);

  const atCap = items.length >= MAX_FLAG_PRESETS;

  function addItem() {
    if (atCap || disabled) return;
    const next: FlagPreset = { id: uuid(), name: t('flagPresets.newItem'), icon: DEFAULT_ICON, color: DEFAULT_COLOR };
    onChange([...items, next]);
    setAutoFocusId(next.id);
  }

  function updateItem(id: string, patch: Partial<Omit<FlagPreset, 'id'>>) {
    onChange(items.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function removeItem(id: string) {
    onChange(items.filter((it) => it.id !== id));
  }

  return (
    <div className={styles.customIntel}>
      {items.length > 0 && (
        <div className={styles.list}>
          {items.map((it) => (
            <div key={it.id} className={styles.row}>
              {/* Native colour input inside a label: the swatch is the target,
                  and clicking it opens the OS picker. Same idiom as the intel
                  editor, so the two lists look like siblings. */}
              <label className={styles.swatch} style={{ background: it.color }}>
                <input
                  type="color"
                  value={it.color}
                  disabled={disabled}
                  onChange={(e) => updateItem(it.id, { color: e.target.value })}
                />
              </label>
              <button
                type="button"
                className="icon-btn"
                disabled={disabled}
                onClick={() => setPickingFor(it.id)}
                title={t('flagPresets.pickIcon')}
                aria-label={t('flagPresets.pickIcon')}
              >
                <DynamicIcon name={it.icon} size={16} weight="fill" />
              </button>
              <input
                type="text"
                className={styles.labelInput}
                value={it.name}
                maxLength={FLAG_NAME_MAX}
                disabled={disabled}
                ref={(el) => {
                  if (el && autoFocusId === it.id) { el.focus(); el.select(); setAutoFocusId(null); }
                }}
                onChange={(e) => updateItem(it.id, { name: e.target.value })}
              />
              <button
                type="button"
                className="icon-btn"
                disabled={disabled}
                onClick={() => removeItem(it.id)}
                title={t('flagPresets.remove')}
                aria-label={t('flagPresets.remove')}
              >
                <TrashIcon size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        className="map-sidebar__action"
        onClick={addItem}
        disabled={atCap || disabled}
        title={atCap ? t('flagPresets.max', { count: MAX_FLAG_PRESETS }) : undefined}
      >
        <PlusIcon size={13} /> {t('flagPresets.add')}
      </button>

      {pickingFor && (
        <IconPickerDialog
          current={items.find((i) => i.id === pickingFor)?.icon ?? null}
          onPick={(name) => updateItem(pickingFor, { icon: name })}
          onClose={() => setPickingFor(null)}
        />
      )}
    </div>
  );
}
