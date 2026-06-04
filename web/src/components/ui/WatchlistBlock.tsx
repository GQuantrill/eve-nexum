import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { TrashIcon, PlusIcon } from '@phosphor-icons/react';
import { useMapStore } from '../../store/mapStore';
import { useWatchlist, MAX_WATCH } from '../../hooks/useWatchlist';
import { useUserSetting } from '../../hooks/useUserSetting';
import { WATCH_MARKERS, watchMarker } from '../../data/watchMarkers';
import type { WatchEntry, WatchMarkerKind } from '../../types';

export function WatchlistBlock() {
  const { t } = useTranslation();
  const [items, setItems] = useWatchlist();
  const [soundOn, setSoundOn] = useUserSetting<boolean>('nexum.watchlist.sound', true);
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);

  // Normalised names of systems on the active map, so each row can show a
  // little "on map now" dot when the hole it's watching is present.
  const systems = useMapStore((s) => s.map.systems);
  const presentNames = useMemo(
    () => new Set(systems.map((s) => (s.name ?? '').trim().toLowerCase()).filter(Boolean)),
    [systems],
  );

  function addItem() {
    if (items.length >= MAX_WATCH) return;
    const next: WatchEntry = { id: uuid(), query: '', note: '', marker: 'target' };
    setItems([...items, next]);
    setAutoFocusId(next.id);
  }

  function updateItem(id: string, patch: Partial<Omit<WatchEntry, 'id'>>) {
    setItems(items.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function removeItem(id: string) {
    setItems(items.filter((it) => it.id !== id));
  }

  const atCap = items.length >= MAX_WATCH;

  return (
    <div className="watchlist">
      <div className="map-sidebar__hint">{t('watchlist.hint')}</div>

      <label className="watchlist__sound">
        <input
          type="checkbox"
          className="map-sidebar__toggle-input"
          checked={soundOn}
          onChange={(e) => setSoundOn(e.target.checked)}
        />
        <span>{t('watchlist.chimeToggle')}</span>
      </label>

      {items.length > 0 && (
        <div className="watchlist__list">
          {items.map((it) => {
            const def = watchMarker(it.marker);
            const onMap = it.query.trim() !== '' && presentNames.has(it.query.trim().toLowerCase());
            return (
              <div key={it.id} className="watchlist__row">
                <select
                  className="watchlist__marker"
                  value={it.marker}
                  onChange={(e) => updateItem(it.id, { marker: e.target.value as WatchMarkerKind })}
                  title={t(`watchMarker.${it.marker}`)}
                  style={{ color: def.color }}
                  aria-label={t('watchlist.markerAria')}
                >
                  {WATCH_MARKERS.map((m) => (
                    <option key={m.kind} value={m.kind}>
                      {m.glyph} {t(`watchMarker.${m.kind}`)}
                    </option>
                  ))}
                </select>
                <div className="watchlist__fields">
                  <div className="watchlist__query-wrap">
                    <input
                      type="text"
                      className="watchlist__query"
                      value={it.query}
                      maxLength={48}
                      onChange={(e) => updateItem(it.id, { query: e.target.value })}
                      placeholder={t('watchlist.queryPlaceholder')}
                      spellCheck={false}
                      ref={(el) => {
                        if (el && autoFocusId === it.id) {
                          el.focus();
                          setAutoFocusId(null);
                        }
                      }}
                    />
                    {onMap && (
                      <span className="watchlist__onmap" title={t('watchlist.onMap')} aria-label={t('watchlist.onMap')} />
                    )}
                  </div>
                  <input
                    type="text"
                    className="watchlist__note"
                    value={it.note}
                    maxLength={120}
                    onChange={(e) => updateItem(it.id, { note: e.target.value })}
                    placeholder={t('watchlist.notePlaceholder')}
                  />
                </div>
                <button
                  type="button"
                  className="watchlist__remove"
                  onClick={() => removeItem(it.id)}
                  title={t('watchlist.remove')}
                >
                  <TrashIcon size={14} weight="regular" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        className="map-sidebar__action"
        onClick={addItem}
        disabled={atCap}
        title={atCap ? t('watchlist.max', { count: MAX_WATCH }) : undefined}
      >
        <PlusIcon size={14} weight="bold" /> {t('watchlist.add')}
      </button>
    </div>
  );
}
