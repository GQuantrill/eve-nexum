import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { TrashIcon, PlusIcon, CrosshairIcon } from '@phosphor-icons/react';
import { useMapStore } from '../../store/mapStore';
import { useWatchlist, MAX_WATCH } from '../../hooks/useWatchlist';
import { useUserSetting } from '../../hooks/useUserSetting';
import { WATCH_MARKERS, watchMarker } from '../../data/watchMarkers';
import { WATCH_CHARACTERISTICS } from '../../data/watchCharacteristics';
import { matchKey, systemMatchesEntry, connectionMatchesEntry } from '../../utils/watchMatch';
import { CLASS_LABELS, EFFECT_LABELS } from '../../data/wormholes';
import type { WatchEntry, WatchMatch, WatchMarkerKind } from '../../types';

// Human label for a non-typed (characteristic) match — shown read-only on the
// row, since those are added/removed via the quick-add palette.
function matchLabel(m: WatchMatch): string {
  switch (m.by) {
    case 'class':    return m.cls === 'C13' ? 'Shattered' : CLASS_LABELS[m.cls];
    case 'effect':   return EFFECT_LABELS[m.effect];
    case 'frigHole': return 'Frig holes';
    default:         return '';
  }
}

export function WatchlistBlock() {
  const { t } = useTranslation();
  const [items, setItems] = useWatchlist();
  const [soundOn, setSoundOn] = useUserSetting<boolean>('nexum.watchlist.sound', true);
  const [autoFocusId, setAutoFocusId] = useState<string | null>(null);

  const systems     = useMapStore((s) => s.map.systems);
  const connections = useMapStore((s) => s.map.connections);
  const sigTypesBySystem = useMapStore((s) => s.sigTypesBySystem);
  const requestCenterOnNode = useMapStore((s) => s.requestCenterOnNode);

  const sysById = useMemo(() => new Map(systems.map((s) => [s.id, s])), [systems]);

  // The map nodes each entry currently matches (with a display label) — drives
  // the "show on map" button + its expandable list. Connection matches centre
  // on an endpoint node, since connections have no node of their own. Cheap: a
  // few entries over the map's systems/edges.
  const matchTargets = useMemo(() => {
    const m = new Map<string, { nodeId: string; label: string }[]>();
    for (const it of items) {
      const seen = new Set<string>();
      const targets: { nodeId: string; label: string }[] = [];
      const push = (nodeId: string | undefined) => {
        if (!nodeId || seen.has(nodeId)) return;
        seen.add(nodeId);
        targets.push({ nodeId, label: sysById.get(nodeId)?.name || '?' });
      };
      for (const s of systems) if (systemMatchesEntry(it, s, sigTypesBySystem[s.id])) push(s.id);
      for (const c of connections) if (connectionMatchesEntry(it, c)) push(c.sourceId || c.targetId);
      targets.sort((a, b) => a.label.localeCompare(b.label));
      m.set(it.id, targets);
    }
    return m;
  }, [items, systems, connections, sigTypesBySystem, sysById]);

  // Which entry's match list is expanded (only relevant when an entry has >1
  // match). A single match jumps straight to it; multiple toggle the list.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  function locate(entryId: string) {
    const targets = matchTargets.get(entryId);
    if (!targets || targets.length === 0) return;
    if (targets.length === 1) { requestCenterOnNode(targets[0].nodeId); return; }
    setExpandedId((cur) => (cur === entryId ? null : entryId));
  }

  const activeKeys = useMemo(() => new Set(items.map((it) => matchKey(it.match))), [items]);

  const atCap = items.length >= MAX_WATCH;

  function addManual() {
    if (atCap) return;
    const next: WatchEntry = { id: uuid(), match: { by: 'system', query: '' }, note: '', marker: 'target' };
    setItems([...items, next]);
    setAutoFocusId(next.id);
  }

  function toggleCharacteristic(match: WatchMatch, marker: WatchMarkerKind) {
    const mk = matchKey(match);
    if (activeKeys.has(mk)) {
      setItems(items.filter((it) => matchKey(it.match) !== mk));
    } else {
      if (atCap) return;
      setItems([...items, { id: uuid(), match, note: '', marker }]);
    }
  }

  function updateItem(id: string, patch: Partial<Omit<WatchEntry, 'id'>>) {
    setItems(items.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function setBy(id: string, by: 'system' | 'whType') {
    updateItem(id, { match: by === 'system' ? { by: 'system', query: '' } : { by: 'whType', code: '' } });
  }

  function removeItem(id: string) {
    setItems(items.filter((it) => it.id !== id));
  }

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

      {/* Quick-add palette: tick a characteristic to drop it into the list. */}
      <div className="watchlist__quickadd">
        <div className="map-sidebar__label">{t('watchlist.quickAdd')}</div>
        <div className="watchlist__chips">
          {WATCH_CHARACTERISTICS.map((c) => {
            const active = activeKeys.has(matchKey(c.match));
            return (
              <button
                key={c.key}
                type="button"
                className={`watchlist__chip${active ? ' watchlist__chip--active' : ''}`}
                aria-pressed={active}
                onClick={() => toggleCharacteristic(c.match, c.defaultMarker)}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      {items.length > 0 && (
        <div className="watchlist__list">
          {items.map((it) => {
            const def = watchMarker(it.marker);
            const targets = matchTargets.get(it.id) ?? [];
            const onMap = targets.length > 0;
            const manual = it.match.by === 'system' || it.match.by === 'whType';
            return (
              <div key={it.id} className="watchlist__row">
                <div className="watchlist__row-top">
                  <span className="watchlist__marker-icon" style={{ color: def.color }} title={t(`watchMarker.${it.marker}`)}>
                    <def.Icon size={16} weight="fill" />
                  </span>
                  <select
                    className="watchlist__marker"
                    value={it.marker}
                    onChange={(e) => updateItem(it.id, { marker: e.target.value as WatchMarkerKind })}
                    title={t(`watchMarker.${it.marker}`)}
                    aria-label={t('watchlist.markerAria')}
                  >
                    {WATCH_MARKERS.map((m) => (
                      <option key={m.kind} value={m.kind}>{t(`watchMarker.${m.kind}`)}</option>
                    ))}
                  </select>
                  {manual ? (
                    <select
                      className="watchlist__by"
                      value={it.match.by}
                      onChange={(e) => setBy(it.id, e.target.value as 'system' | 'whType')}
                      aria-label={t('watchlist.matchByAria')}
                    >
                      <option value="system">{t('watchlist.matchSystem')}</option>
                      <option value="whType">{t('watchlist.matchWhType')}</option>
                    </select>
                  ) : (
                    <span className="watchlist__char-label">{matchLabel(it.match)}</span>
                  )}
                  {onMap && (
                    <button
                      type="button"
                      className={`watchlist__locate${expandedId === it.id ? ' watchlist__locate--open' : ''}`}
                      onClick={() => locate(it.id)}
                      title={targets.length > 1 ? `${t('watchlist.locate')} (${targets.length})` : t('watchlist.locate')}
                      aria-label={t('watchlist.locate')}
                      aria-expanded={targets.length > 1 ? expandedId === it.id : undefined}
                    >
                      <CrosshairIcon size={14} weight="bold" />
                      {targets.length > 1 && <span className="watchlist__locate-count">{targets.length}</span>}
                    </button>
                  )}
                  <button
                    type="button"
                    className="watchlist__remove"
                    onClick={() => removeItem(it.id)}
                    title={t('watchlist.remove')}
                  >
                    <TrashIcon size={14} weight="regular" />
                  </button>
                </div>

                {expandedId === it.id && targets.length > 1 && (
                  <div className="watchlist__matches">
                    {targets.map((tgt) => (
                      <button
                        key={tgt.nodeId}
                        type="button"
                        className="watchlist__match"
                        onClick={() => requestCenterOnNode(tgt.nodeId)}
                      >
                        <CrosshairIcon size={11} weight="bold" />
                        {tgt.label}
                      </button>
                    ))}
                  </div>
                )}

                <div className="watchlist__row-bottom">
                  {it.match.by === 'system' && (
                    <input
                      type="text"
                      className="watchlist__value"
                      value={it.match.query}
                      maxLength={48}
                      onChange={(e) => updateItem(it.id, { match: { by: 'system', query: e.target.value } })}
                      placeholder={t('watchlist.queryPlaceholder')}
                      spellCheck={false}
                      ref={(el) => { if (el && autoFocusId === it.id) { el.focus(); setAutoFocusId(null); } }}
                    />
                  )}
                  {it.match.by === 'whType' && (
                    <input
                      type="text"
                      className="watchlist__value"
                      value={it.match.code}
                      maxLength={8}
                      onChange={(e) => updateItem(it.id, { match: { by: 'whType', code: e.target.value.toUpperCase() } })}
                      placeholder={t('watchlist.whPlaceholder')}
                      spellCheck={false}
                    />
                  )}
                  <input
                    type="text"
                    className="watchlist__note"
                    value={it.note}
                    maxLength={120}
                    onChange={(e) => updateItem(it.id, { note: e.target.value })}
                    placeholder={t('watchlist.notePlaceholder')}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        className="map-sidebar__action"
        onClick={addManual}
        disabled={atCap}
        title={atCap ? t('watchlist.max', { count: MAX_WATCH }) : undefined}
      >
        <PlusIcon size={14} weight="bold" /> {t('watchlist.add')}
      </button>
    </div>
  );
}
