import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { useEsiSearch, systemResultLabel, type SystemSearchResult } from '../../hooks/useEsiSearch';
import { useRoute } from '../../hooks/useRoute';
import { useRouteOrigin } from '../../hooks/useRouteOrigin';
import { useMapStore } from '../../store/mapStore';
import { useSystemAlias } from '../../hooks/useSystemAlias';
import { RouteSquares } from './routeUi';
import { canSetAutopilot } from '../../utils/routeActions';
import { setDestination } from '../../api/waypoint';
import { jumps as jumpsLabel } from '../../i18n/format';
import { XIcon, ArrowsLeftRightIcon, CrosshairIcon } from '../../icons';

// Plan a route between any two systems in New Eden.
//
// Every other routing surface in the app (Closest Systems, Clones, Fleet, A0,
// Scout Connections, Chain Exits) routes FROM the pilot's current position to
// somewhere the app already knows about. This is the one place both ends are
// yours to choose -- which is what people arrive expecting, having used
// Pathfinder or Dotlan.
//
// It owns no routing logic: /api/route has always accepted an arbitrary origin,
// and useRoute already takes it as a parameter, so this is a picker and a
// renderer over machinery that was already general.
//
// Note it deliberately does NOT use SystemCombobox, which is scoped to systems
// on the current map -- Jita to Amarr has nothing to do with any map.

interface Picked { id: number; name: string }

// Most alias matches listed above the search results. Aliases are a handful per
// map, so this only bites on a very short query.
const MAX_ALIAS_MATCHES = 5;

/** The picked system as the pilot knows it: its alias on this map when it has
 *  one, with the real name alongside so the two never get confused. */
function PickedName({ name }: { name: string }) {
  const aliasName = useSystemAlias();
  const shown = aliasName(name);
  return (
    <span className="route-planner__picked-name">
      <strong>{shown}</strong>
      {shown !== name && <span className="route-planner__real-name">{name}</span>}
    </span>
  );
}

interface SavedPlan {
  id: string;
  name: string;
  fromEveId: number;
  toEveId:   number;
  fromName:  string | null;
  toName:    string | null;
}

/**
 * Search any system by name and hold the pick. Built on useEsiSearch over the
 * shared `.search-results` dropdown styling.
 *
 * JumpPlannerModal has a similar field, but it is welded to that feature --
 * corp structures and NPC stations above the system results, and an LS/NS-only
 * filter because a jump drive cannot reach anywhere else. Rebuilding that one
 * on this is a worthwhile follow-up; doing it here would mean refactoring a
 * shipped feature to land a new one.
 */
function SystemSearchField({ label, value, onPick, extra }: {
  label:  string;
  value:  Picked | null;
  onPick: (v: Picked | null) => void;
  extra?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const { results, loading } = useEsiSearch(query);

  // Systems on the current map whose ALIAS matches, so "home" finds the system
  // you've called home. ESI only knows real names, so these come from the map
  // and sit above its results, which drop any system already listed here.
  const systems = useMapStore((s) => s.map.systems);
  const aliasMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const seen = new Set<number>();
    const out: Array<{ id: number; name: string; alias: string }> = [];
    for (const s of systems) {
      const alias = s.alias?.trim();
      if (!alias || s.eveSystemId == null || seen.has(s.eveSystemId)) continue;
      if (!alias.toLowerCase().includes(q)) continue;
      seen.add(s.eveSystemId);
      out.push({ id: s.eveSystemId, name: s.name, alias });
      if (out.length >= MAX_ALIAS_MATCHES) break;
    }
    return out;
  }, [systems, query]);
  const aliasIds = new Set(aliasMatches.map((m) => m.id));
  const esiResults = results.filter((r) => !aliasIds.has(r.id));

  const open = query.trim().length >= 2 && (esiResults.length > 0 || aliasMatches.length > 0 || loading);

  const pick = (r: SystemSearchResult) => { onPick({ id: r.id, name: r.name }); setQuery(''); };

  return (
    <div className="route-planner__field">
      <div className="route-planner__label">{label}</div>
      {value ? (
        <div className="route-planner__picked">
          <PickedName name={value.name} />
          <span className="route-planner__picked-actions">
            {extra}
            <button
              type="button"
              className="icon-btn"
              onClick={() => onPick(null)}
              title={t('routePlanner.clearField')}
              aria-label={t('routePlanner.clearField')}
            >
              <XIcon size={12} weight="bold" />
            </button>
          </span>
        </div>
      ) : (
        <div className="route-planner__search">
          <input
            className="chains-new__name"
            type="text"
            value={query}
            placeholder={t('routePlanner.searchSystem')}
            onChange={(e) => setQuery(e.target.value)}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
          />
          {extra}
          {open && (
            <ul className="search-results">
              {aliasMatches.map((m) => (
                <li
                  key={`alias-${m.id}`}
                  className="search-results__item"
                  role="option"
                  aria-selected={false}
                  onClick={() => { onPick({ id: m.id, name: m.name }); setQuery(''); }}
                >
                  {m.alias}
                  <span className="search-results__class">{m.name}</span>
                </li>
              ))}
              {loading && esiResults.length === 0 && aliasMatches.length === 0 && (
                <li className="search-results__item route-planner__status">{t('routePlanner.searching')}</li>
              )}
              {esiResults.map((r) => (
                <li
                  key={r.id}
                  className="search-results__item"
                  role="option"
                  aria-selected={false}
                  onClick={() => pick(r)}
                >
                  {r.name}
                  <span className="search-results__class">{systemResultLabel(r)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function RoutePlannerPane() {
  const { t } = useTranslation();
  const origin = useRouteOrigin();
  const aliasName = useSystemAlias();

  // THREE states, not two, because "cleared" and "follow me" are different
  // intents that used to share `null`:
  //   undefined  follow my current location (the default, tracks as you fly)
  //   null       deliberately emptied -- stay empty, waiting for a start system
  //   Picked     a system chosen by hand
  // Collapsing the first two meant the clear button set "follow me", which
  // instantly refilled the field with the pilot's system: the field could not
  // be emptied at all.
  //
  // Derived rather than copied into state on a timer -- syncing it would fight
  // the location poll.
  const [fromOverride, setFromOverride] = useState<Picked | null | undefined>(undefined);
  const [to, setTo] = useState<Picked | null>(null);
  const from: Picked | null = fromOverride !== undefined
    ? fromOverride
    : (origin.systemId != null ? { id: origin.systemId, name: origin.name ?? String(origin.systemId) } : null);
  const followingPilot = fromOverride === undefined && origin.systemId != null;

  // Same source the other route panes read -- the store, not a settings key.
  const routeMode = useMapStore((s) => s.routeMode);

  // Only ask for a route once both ends are known and distinct.
  const targets = from && to && from.id !== to.id ? [to.id] : [];
  const routes = useRoute(from?.id ?? null, targets);
  const route = to ? routes[String(to.id)] : undefined;

  const swap = () => {
    if (!from || !to) return;
    setFromOverride(to);
    setTo(from);
  };

  // ── Saved plans ─────────────────────────────────────────────────────────
  const [plans, setPlans] = useState<SavedPlan[]>([]);
  const [saveName, setSaveName] = useState('');
  const [busy, setBusy] = useState(false);
  const loadedOnce = useRef(false);

  const refreshPlans = useCallback(() => {
    api<SavedPlan[]>('/api/route-plans')
      .then(setPlans)
      .catch(() => setPlans([]));
  }, []);

  useEffect(() => {
    if (loadedOnce.current) return;
    loadedOnce.current = true;
    refreshPlans();
  }, [refreshPlans]);

  const savePlan = () => {
    if (!from || !to || !saveName.trim() || busy) return;
    setBusy(true);
    api<{ id: string }>('/api/route-plans', {
      method: 'POST',
      body: JSON.stringify({ name: saveName.trim(), fromEveId: from.id, toEveId: to.id }),
    })
      .then(() => { setSaveName(''); refreshPlans(); })
      .catch(() => { /* the list simply doesn't gain a row */ })
      .finally(() => setBusy(false));
  };

  const deletePlan = (id: string) => {
    api(`/api/route-plans/${id}`, { method: 'DELETE' })
      .then(refreshPlans)
      .catch(() => { /* leave the row; a refresh will correct it */ });
  };

  const loadPlan = (p: SavedPlan) => {
    setFromOverride({ id: p.fromEveId, name: p.fromName ?? String(p.fromEveId) });
    setTo({ id: p.toEveId, name: p.toName ?? String(p.toEveId) });
  };

  return (
    <div className="scout-pane route-planner">
      <SystemSearchField
        label={t('routePlanner.from')}
        value={from}
        onPick={setFromOverride}
        extra={!followingPilot && origin.systemId != null ? (
          <button
            type="button"
            className="icon-btn"
            onClick={() => setFromOverride(undefined)}
            title={t('routePlanner.useMyLocation')}
            aria-label={t('routePlanner.useMyLocation')}
          >
            <CrosshairIcon size={13} weight="regular" />
          </button>
        ) : undefined}
      />

      <div className="route-planner__swap">
        <button
          type="button"
          className="icon-btn"
          onClick={swap}
          disabled={!from || !to}
          title={t('routePlanner.swap')}
          aria-label={t('routePlanner.swap')}
        >
          <ArrowsLeftRightIcon size={14} weight="regular" />
        </button>
      </div>

      <SystemSearchField label={t('routePlanner.to')} value={to} onPick={setTo} />

      {followingPilot && from && (
        <div className="scout-pane__note scout-pane__note--lastknown">
          {origin.fromLastKnown
            ? t('route.fromLastKnown', { system: aliasName(from.name) })
            : t('routePlanner.followingLocation', { system: aliasName(from.name) })}
        </div>
      )}

      {/* Result. `route === undefined` with both ends chosen means either still
          in flight or genuinely unreachable; the engine omits unreachable
          targets rather than returning a zero-jump entry. */}
      {!from || !to ? (
        <div className="scout-pane__empty">{t('routePlanner.pickBoth')}</div>
      ) : from.id === to.id ? (
        <div className="scout-pane__empty">{t('routePlanner.sameSystem')}</div>
      ) : route ? (
        <div className="route-planner__result">
          <div className="route-planner__jumps">
            {jumpsLabel(t, route.jumps)}
            <span className="route-planner__mode">
              {t(routeMode === 'secure' ? 'a0.modeSecure' : 'a0.modeShortest')}
            </span>
          </div>
          <RouteSquares route={route} />
          {canSetAutopilot(route) && (
            <button
              type="button"
              className="sys-btn"
              onClick={() => { setDestination(to.id, to.name).catch(() => {}); }}
            >
              {t('waypoint.setDestination')}
            </button>
          )}
        </div>
      ) : (
        <div className="scout-pane__empty">{t('routePlanner.noRoute')}</div>
      )}

      {/* ── Saved routes ── */}
      <div className="route-planner__saved">
        <div className="route-planner__label">{t('routePlanner.savedHdr')}</div>
        {plans.length === 0 ? (
          <div className="scout-pane__empty">{t('routePlanner.savedEmpty')}</div>
        ) : (
          <div className="route-planner__chips">
            {plans.map((p) => (
              <span key={p.id} className="route-planner__chip">
                <button type="button" onClick={() => loadPlan(p)} title={t('routePlanner.loadPlan')}>
                  <strong>{p.name}</strong>{' '}
                  <span className="route-planner__chip-ends">
                    {p.fromName ? aliasName(p.fromName) : p.fromEveId} → {p.toName ? aliasName(p.toName) : p.toEveId}
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => deletePlan(p.id)}
                  title={t('routePlanner.deletePlan')}
                  aria-label={t('routePlanner.deletePlan')}
                >
                  <XIcon size={11} weight="bold" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="route-planner__save">
          <input
            className="chains-new__name"
            value={saveName}
            placeholder={t('routePlanner.nameToSave')}
            onChange={(e) => setSaveName(e.target.value)}
          />
          <button
            type="button"
            className="sys-btn"
            disabled={!from || !to || from.id === to.id || !saveName.trim() || busy}
            onClick={savePlan}
          >
            {t('routePlanner.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
