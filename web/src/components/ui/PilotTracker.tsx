import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { useMapStore } from '../../store/mapStore';
import { useUserSetting } from '../../hooks/useUserSetting';
import { useCanEditContent } from '../../hooks/useCanEditContent';
import { useCharacterLocation } from '../../hooks/useCharacterLocation';
import { useStandings } from '../../hooks/useStandings';
import { usePilotSightings, refreshPilotSightings } from '../../hooks/usePilotSightings';
import { recordWatchedFromFeed } from '../../desktop/intel';
import { timeAgo } from '../../i18n/format';
import { FireIcon, StarIcon, XIcon } from '../../icons';
import type { HeatMetric } from '../../utils/heatmap';
import type { LocalData, LocalPilot, StoredScan } from '../../utils/dscanView';
import {
  sanitiseWatched, sanitiseHeatPilot, summarise, MAX_WATCHED,
  WATCH_KEY, HEAT_PILOT_KEY, MAP_FILTER_KEY, HIGHLIGHT_KEY,
  type Sighting, type WatchedPilot,
} from '../../utils/pilotWatch';
import { Select } from './Select';
import styles from './PilotTracker.module.css';

// The Intel panel's pilot tracking, in the browser and the desktop app alike.
//
// Paste local: the list is pinned to a system on the open map like any local
// scan, which records every pilot in it there (server: pilotSightings). The
// result lists who was in local, their standing, and where else each has been
// seen in the last 30 days. Star a pilot to watch them: the watch list shows
// where they were last seen, and one of them can be drawn on the map as the
// "Watched pilot" heatmap.

const ERROR_KEYS = {
  empty:         'dscan.errors.empty',
  unrecognised:  'pilots.notLocal',
  too_many:      'dscan.errors.tooMany',
  invalid_text:  'dscan.errors.tooMany',
  lookup_failed: 'dscan.errors.lookupFailed',
} as const;

type Tone = 'friendly' | 'good' | 'neutral' | 'bad' | 'hostile';
const toneOf = (v: number): Tone =>
  v > 5 ? 'friendly' : v > 0 ? 'good' : v < -5 ? 'hostile' : v < 0 ? 'bad' : 'neutral';
const TONE_RANK: Record<Tone, number> = { hostile: 0, bad: 1, neutral: 2, good: 3, friendly: 4 };

interface KnownPilot { characterId: number; name: string; systemName: string | null; seenAt: string }

interface PasteResult { system: string; eveSystemId: number; data: LocalData }

export function PilotTracker() {
  const { t } = useTranslation();
  const canEdit = useCanEditContent();
  const activeMapId = useMapStore((s) => s.activeMapId);
  const maps = useMapStore((s) => s.maps);
  const systems = useMapStore((s) => s.map.systems);
  const selectSystem = useMapStore((s) => s.selectSystem);
  const selected = useMapStore((s) => s.map.systems.find((x) => x.id === s.selectedSystemId));
  const location = useCharacterLocation();
  const standings = useStandings();

  const [watchedRaw, setWatched] = useUserSetting<WatchedPilot[]>(WATCH_KEY, []);
  const watched = sanitiseWatched(watchedRaw);
  const [heatPilotRaw, setHeatPilot] = useUserSetting<WatchedPilot | null>(HEAT_PILOT_KEY, null);
  const heatPilot = sanitiseHeatPilot(heatPilotRaw);
  const [heatMetric, setHeatMetric] = useUserSetting<HeatMetric>('nexum.map.heatmap', 'none');
  const [markOnMap, setMarkOnMap] = useUserSetting<boolean>(HIGHLIGHT_KEY, true);
  const [mapFilterRaw, setMapFilter] = useUserSetting<string>(MAP_FILTER_KEY, '');
  const mapFilter = typeof mapFilterRaw === 'string' && maps.some((m) => m.id === mapFilterRaw) ? mapFilterRaw : '';

  const [pasteOpen, setPasteOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PasteResult | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [addName, setAddName] = useState('');
  // Pilots already seen on the maps you can see whose name contains what's
  // typed: click one to watch them.
  // Kept with the text they're for, so stale ones never show.
  const [found, setFound] = useState<{ q: string; rows: KnownPilot[] }>({ q: '', rows: [] });
  const [addFocused, setAddFocused] = useState(false);
  const addQuery = addName.trim();
  useEffect(() => {
    if (addQuery.length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      api<KnownPilot[]>(`/api/pilots/known?q=${encodeURIComponent(addQuery)}`)
        .then((rows) => { if (live) setFound({ q: addQuery, rows }); })
        .catch(() => { if (live) setFound({ q: addQuery, rows: [] }); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [addQuery]);
  const suggestions = found.q === addQuery && addQuery.length >= 2 ? found.rows : [];
  const [addError, setAddError] = useState<string | null>(null);

  // Where a paste is recorded: the selected system, else where you are, if
  // it's on the open map. A placeholder node has no EVE id and can't hold one.
  const here = location.system ? systems.find((s) => s.eveSystemId === location.system?.eveSystemId) : undefined;
  const target = selected?.eveSystemId ? selected : here;

  const resultIds = result ? result.data.pilots.map((p) => p.id) : [];
  const watchedIds = watched.map((p) => p.id);
  const rows = usePilotSightings([...resultIds, ...watchedIds], mapFilter);
  const summaries = summarise(rows ?? []);
  const isWatched = (id: number) => watchedIds.includes(id);
  const mapName = (id: string) => maps.find((m) => m.id === id)?.name ?? '';

  const toggleWatch = (p: WatchedPilot) => {
    if (isWatched(p.id)) {
      setWatched(watched.filter((w) => w.id !== p.id));
      if (heatPilot?.id === p.id) {
        setHeatPilot(null);
        if (heatMetric === 'pilot') setHeatMetric('none');
      }
    } else if (watched.length < MAX_WATCHED) {
      setWatched([...watched, { id: p.id, name: p.name }]);
      // Intel already in the feed that names them (desktop app; a no-op elsewhere).
      void recordWatchedFromFeed([{ id: p.id, name: p.name }]).then(() => refreshPilotSightings());
    }
  };

  const showHeat = (p: WatchedPilot) => {
    if (heatPilot?.id === p.id && heatMetric === 'pilot') { setHeatMetric('none'); return; }
    setHeatPilot({ id: p.id, name: p.name });
    setHeatMetric('pilot');
  };

  const tone = (p: { id: number; c: number | null; a: number | null }): Tone => {
    const self = standings.self;
    if (self && ((p.c != null && p.c === self.corpId) || (p.a != null && p.a === self.allianceId))) return 'friendly';
    // The most specific contact wins, as in game: the pilot, their corp, then
    // their alliance.
    const tries: Array<['character' | 'corporation' | 'alliance', number | null]> =
      [['character', p.id], ['corporation', p.c], ['alliance', p.a]];
    for (const [kind, id] of tries) {
      if (id == null) continue;
      const s = standings.getStanding(kind, id);
      if (s.character !== null || s.corp !== null || s.alliance !== null) return toneOf(s.effective);
    }
    return 'neutral';
  };

  const submit = async () => {
    if (busy || !target || !activeMapId) return;
    if (!text.trim()) { setError(t('dscan.errors.empty')); return; }
    setBusy(true);
    setError(null);
    try {
      const { id } = await api<{ id: string; kind: string }>('/api/dscan', {
        method: 'POST',
        body: JSON.stringify({ text, mapId: activeMapId, systemId: target.id }),
      });
      const scan = await api<StoredScan>(`/api/dscan/${id}`);
      if (target.eveSystemId) useMapStore.getState().bumpDscanRev(target.eveSystemId);
      if (scan.data.kind !== 'local') { setError(t('pilots.notLocal')); return; }
      setResult({ system: target.name, eveSystemId: target.eveSystemId ?? 0, data: scan.data });
      setText('');
      setPasteOpen(false);
      refreshPilotSightings();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      const status = err instanceof ApiError ? err.status : 0;
      setError(
        status === 429 ? t('dscan.errors.rateLimited')
          : code && code in ERROR_KEYS ? t(ERROR_KEYS[code as keyof typeof ERROR_KEYS])
          : t('dscan.errors.failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  const unwatchedSuggestions = suggestions.filter((k) => !isWatched(k.characterId));

  const addByName = async () => {
    const q = addName.trim();
    if (!q) return;
    setAddError(null);
    try {
      const { match } = await api<{ match: { id: number | string; name: string } | null }>(
        `/api/search/characters?q=${encodeURIComponent(q)}`);
      // A pilot who has logged in here comes back with the id as a string
      // (a BIGINT column), so make it a number before it's kept.
      const id = Number(match?.id);
      if (!match || !Number.isInteger(id) || id <= 0) { setAddError(t('pilots.noSuchPilot', { name: q })); return; }
      if (!isWatched(id)) toggleWatch({ id, name: match.name });
      setAddName('');
    } catch {
      setAddError(t('dscan.errors.failed'));
    }
  };

  const systemButton = (s: Sighting) => {
    const name = s.systemName ?? `#${s.eveSystemId}`;
    const node = s.mapId === activeMapId ? systems.find((x) => x.eveSystemId === s.eveSystemId) : undefined;
    return node
      ? <button type="button" className={styles.sysLink} onClick={() => selectSystem(node.id)}
          data-tooltip={t('intelFeed.selectSystem', { system: name })}>{name}</button>
      : <span className={styles.sys}>{name}</span>;
  };

  // Paste result order: watched first, then whoever has been seen elsewhere
  // most, then the worst standing.
  const pasted = result ? [...result.data.pilots].map((p) => {
    const elsewhere = (rows ?? []).filter((r) => r.characterId === p.id && r.eveSystemId !== result.eveSystemId);
    return { p, tone: tone(p), elsewhere, systems: new Set(elsewhere.map((r) => r.eveSystemId)).size };
  }).sort((a, b) =>
    Number(isWatched(b.p.id)) - Number(isWatched(a.p.id))
    || b.systems - a.systems
    || TONE_RANK[a.tone] - TONE_RANK[b.tone]
    || a.p.n.localeCompare(b.p.n)) : [];

  const nameOf = (data: LocalData, id: number | null) => (id != null ? data.names[id] ?? '' : '');

  return (
    <div className={styles.tracker}>
      <div className={styles.bar}>
        <button type="button" className={`btn ${pasteOpen ? 'btn--primary' : 'btn--ghost'} ${styles.pasteBtn}`}
          onClick={() => setPasteOpen((o) => !o)} aria-expanded={pasteOpen}>{t('pilots.pasteLocal')}</button>
        <Select
          className={styles.mapFilter}
          ariaLabel={t('pilots.mapFilter')}
          title={t('pilots.mapFilter')}
          value={mapFilter}
          onChange={(v) => setMapFilter(v)}
          options={[{ value: '', label: t('pilots.allMaps') }, ...maps.map((m) => ({ value: m.id, label: m.name }))]}
        />
      </div>

      {pasteOpen && (
        <div className={styles.paste}>
          <textarea
            className={styles.textarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit(); }}
            placeholder={t('pilots.pastePlaceholder')}
            aria-label={t('pilots.pastePlaceholder')}
            spellCheck={false}
            rows={4}
            autoFocus
          />
          <p className={styles.hint}>
            {!canEdit ? t('pilots.cantRecord')
              : target ? t('pilots.recordsIn', { system: target.name })
              : t('pilots.pickSystem')}
          </p>
          <button type="button" className="btn btn--primary" onClick={() => void submit()}
            disabled={busy || !canEdit || !target}>
            {busy ? t('dscan.analysing') : t('pilots.check')}
          </button>
          {error && <p className={styles.error} role="alert">{error}</p>}
        </div>
      )}

      {result && (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span>{t('pilots.inLocal', { count: result.data.pilots.length, system: result.system })}</span>
            <button type="button" className="icon-btn" onClick={() => setResult(null)}
              aria-label={t('actions.close')} data-tooltip={t('actions.close')}><XIcon size={12} weight="bold" /></button>
          </div>
          <ul className={styles.list}>
            {pasted.map(({ p, tone: tn, elsewhere, systems: n }) => (
              <li key={p.id} className={`${styles.row} ${styles[tn]}`}>
                <PilotName p={p} />
                <span className={styles.org}>
                  {[nameOf(result.data, p.c), nameOf(result.data, p.a)].filter(Boolean).join(' / ')}
                </span>
                {n > 0 && (
                  <span className={styles.seen}
                    data-tooltip={t('pilots.lastSeen', { system: elsewhere[0].systemName ?? '', ago: timeAgo(t, new Date(elsewhere[0].seenAt)) })}>
                    {t('pilots.seenElsewhere', { count: n })}
                  </span>
                )}
                <WatchButton watched={isWatched(p.id)} onClick={() => toggleWatch({ id: p.id, name: p.n })} />
              </li>
            ))}
          </ul>
          {result.data.unknown.length > 0 && (
            <p className={styles.hint}>{t('pilots.unknown', { count: result.data.unknown.length })}</p>
          )}
        </section>
      )}

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <span>{t('pilots.watched', { count: watched.length })}</span>
          <label className={styles.toggle} data-tooltip={t('pilots.markOnMapHint')}>
            <input type="checkbox" checked={markOnMap !== false} onChange={(e) => setMarkOnMap(e.target.checked)} />
            {t('pilots.markOnMap')}
          </label>
        </div>
        {watched.length === 0 && <p className={styles.hint}>{t('pilots.watchedEmpty')}</p>}
        <ul className={styles.list}>
          {watched.map((w) => {
            const sum = summaries.get(w.id);
            const open = expanded === w.id;
            const onHeat = heatPilot?.id === w.id && heatMetric === 'pilot';
            return (
              <li key={w.id} className={styles.watchItem}>
                <div className={styles.row}>
                  <button type="button" className={styles.expand} onClick={() => setExpanded(open ? null : w.id)}
                    aria-expanded={open}>{w.name}</button>
                  <span className={styles.org}
                    data-tooltip={sum ? t('pilots.lastSeen', { system: sum.last.systemName ?? '', ago: timeAgo(t, new Date(sum.last.seenAt)) }) : undefined}>
                    {rows == null ? '' : sum
                      ? `${sum.last.systemName ?? ''}, ${timeAgo(t, new Date(sum.last.seenAt))}`
                      : t('pilots.notSeen')}
                  </span>
                  {sum && <span className={styles.seen}>{t('pilots.sightings', { count: sum.count })}</span>}
                  <button type="button" className={`icon-btn ${onHeat ? styles.on : ''}`} onClick={() => showHeat(w)}
                    aria-pressed={onHeat} aria-label={t('pilots.showHeat', { name: w.name })}
                    data-tooltip={t(onHeat ? 'pilots.hideHeat' : 'pilots.showHeat', { name: w.name })}>
                    <FireIcon size={13} />
                  </button>
                  <WatchButton watched onClick={() => toggleWatch(w)} />
                </div>
                {open && (
                  <ul className={styles.sightings}>
                    {(rows ?? []).filter((r) => r.characterId === w.id).slice(0, 25).map((r, i) => (
                      <li key={`${r.seenAt}|${r.eveSystemId}|${i}`} className={styles.sighting}>
                        {systemButton(r)}
                        <span className={styles.org}>
                          {[!mapFilter && mapName(r.mapId), t(r.source === 'local' ? 'pilots.fromLocal' : 'pilots.fromIntel')]
                            .filter(Boolean).join(' · ')}
                        </span>
                        <span className={styles.time} title={new Date(r.seenAt).toLocaleString()}>
                          {timeAgo(t, new Date(r.seenAt))}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        {watched.length < MAX_WATCHED && (
          <form className={styles.add} onSubmit={(e) => { e.preventDefault(); void addByName(); }}>
            <input className={styles.addInput} value={addName} onChange={(e) => setAddName(e.target.value)}
              onFocus={() => setAddFocused(true)} onBlur={() => setAddFocused(false)}
              onKeyDown={(e) => { if (e.key === 'Escape') setFound({ q: '', rows: [] }); }}
              placeholder={t('pilots.addPlaceholder')} aria-label={t('pilots.addPlaceholder')} spellCheck={false} />
            <button type="submit" className="btn btn--ghost" disabled={!addName.trim()}>{t('pilots.add')}</button>
          </form>
        )}
        {addFocused && unwatchedSuggestions.length > 0 && (
          <ul className={styles.suggestions} aria-label={t('pilots.suggestions')}>
            {unwatchedSuggestions.map((k) => (
              <li key={k.characterId}>
                {/* mousedown, not click: the input's blur would hide the list first. */}
                <button type="button" className={styles.suggestion}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    toggleWatch({ id: k.characterId, name: k.name });
                    setAddName('');
                    setAddError(null);
                  }}>
                  <span className={styles.suggestionName}>{k.name}</span>
                  <span className={styles.org}>
                    {[k.systemName, timeAgo(t, new Date(k.seenAt))].filter(Boolean).join(', ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {addError && <p className={styles.error} role="alert">{addError}</p>}
      </section>
    </div>
  );
}

function PilotName({ p }: { p: LocalPilot }) {
  return (
    <a className={styles.name} href={`https://zkillboard.com/character/${p.id}/`} target="_blank" rel="noopener noreferrer">
      {p.n}
    </a>
  );
}

function WatchButton({ watched, onClick }: { watched: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const label = t(watched ? 'pilots.unwatch' : 'pilots.watch');
  return (
    <button type="button" className={`icon-btn ${watched ? styles.on : ''}`} onClick={onClick}
      aria-pressed={watched} aria-label={label} data-tooltip={label}>
      <StarIcon size={13} weight={watched ? 'fill' : 'regular'} />
    </button>
  );
}
