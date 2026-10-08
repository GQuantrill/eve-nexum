import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useScoutConnections, setScoutExpired } from '../../hooks/useScoutConnections';
import { useWormholeTypes } from '../../hooks/useWormholeTypes';
import { whSizeForType, whSizeShort } from '../../utils/wormholeSize';
import { useRouteOrigin } from '../../hooks/useRouteOrigin';
import { useRoute } from '../../hooks/useRoute';
import { RouteSquares } from './routeUi';
import { setWaypoint, canSetAutopilot } from '../../utils/routeActions';
import { useSystemAlias } from '../../hooks/useSystemAlias';
import { truesecColor } from '../../utils/truesec';
import { useMapStore } from '../../store/mapStore';
import { pickHandles } from '../map/edgeUtils';
import { CopyIcon, MapPinSimpleIcon, PathIcon, ProhibitIcon } from '../../icons';
import { Select } from './Select';
import { DASH } from '../../i18n/format';
import { api } from '../../api/client';
import { toast } from '../../utils/toastStore';
import { allSigWrites, allConnWrites, sigKey, pairKey, type SigWrite } from '../../utils/scoutSigCopy';

interface Props {
  scoutSystem: 'Thera' | 'Turnur';
}

type ScoutSort = 'age' | 'closest';

// Per-panel sort preference, remembered client-side. Thera and Turnur keep
// independent choices under their own key.
function readScoutSort(system: string): ScoutSort {
  try {
    return localStorage.getItem(`nexum.scoutSort.${system}`) === 'closest' ? 'closest' : 'age';
  } catch {
    return 'age';
  }
}

const SIZE_LABELS: Record<string, string> = {
  small:  'S',
  medium: 'M',
  large:  'L',
  xlarge: 'XL',
};

// eve-scout `in_system_class`: 'c1'..'c6' for wormhole targets, 'hs'/'ls'/'ns'
// for K-space. Wormhole-class targets can't be set as autopilot waypoints.
function isWormholeClass(cls: string | null): boolean {
  if (!cls) return false;
  return /^c\d+$/i.test(cls) || cls.toLowerCase() === 'thera' || cls.toLowerCase() === 'drifter';
}

// Colour the HS / LS / NS class chip the same way truesec values are
// coloured elsewhere — picks a representative security inside each band
// so the visual matches what you'd see on a system node. Wormhole /
// Thera / Drifter / Pochven keep their default styling (they don't have
// a real security number to map from).
function secClassColor(cls: string | null): string | undefined {
  if (!cls) return undefined;
  const upper = cls.toUpperCase();
  if (upper === 'HS') return truesecColor(0.7);
  if (upper === 'LS') return truesecColor(0.3);
  if (upper === 'NS') return truesecColor(0.0);
  return undefined;
}

// Remaining wormhole lifetime — an upper bound from eve-scout ("< N hours"), so
// it's shown with a leading "<", matching the source's meaning (time left, not age).
function formatRemaining(t: TFunction, hours: number): string {
  if (hours <= 0) return t('scout.expiring');
  if (hours < 1)  return '< 1h';
  return `< ${Math.floor(hours)}h`;
}

export function ScoutConnectionsPane({ scoutSystem }: Props) {
  const { t }    = useTranslation();
  const aliasName = useSystemAlias();
  const all      = useScoutConnections();
  const origin   = useRouteOrigin();
  const routeMode = useMapStore((s) => s.routeMode);
  const whTypes  = useWormholeTypes();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<ScoutSort>(() => readScoutSort(scoutSystem));

  function changeSort(v: ScoutSort) {
    setSortBy(v);
    try {
      localStorage.setItem(`nexum.scoutSort.${scoutSystem}`, v);
    } catch {
      // storage may be unavailable (private mode, etc.) — keep the in-memory choice.
    }
  }

  const filtered = useMemo(
    () => all.filter(c => c.outSystemName === scoutSystem),
    [all, scoutSystem],
  );

  const canRoute = origin.systemId !== null;

  const targetIds = useMemo(() => filtered.map(c => c.inSystemId), [filtered]);
  // Route to each exit WITHOUT this pane's own scout hub spliced in: a route to
  // a Turnur exit that travels through Turnur is circular — it's the hole you'd
  // be taking, so every exit scores (jumps to Turnur + 1) and the whole list
  // ties. What's wanted here is how far each exit sits from you by ordinary
  // travel. The other hub and mapped chains stay in — those are real shortcuts.
  const routes = useRoute(origin.systemId, targetIds, 'active', {
    viaScout: scoutSystem === 'Thera' ? 'thera' : 'turnur',
  });

  // Two sort modes:
  //  - 'age'     : remaining time descending — freshest holes at the top, the
  //                soon-to-collapse ones drop to the bottom.
  //  - 'closest' : fewest jumps via the active route preference (shortest /
  //                secure) ascending, excluding this pane's own hub (see the
  //                useRoute call above). Connections without a usable route (no
  //                k-space location, or wormhole-class target) fall to the
  //                bottom. Age then name break ties in both modes.
  const sorted = useMemo(() => {
    const byAge = (a: typeof filtered[number], b: typeof filtered[number]) => {
      if (a.remainingHours !== b.remainingHours) return b.remainingHours - a.remainingHours;
      return a.inSystemName.localeCompare(b.inSystemName);
    };
    const arr = [...filtered];
    if (sortBy === 'closest') {
      arr.sort((a, b) => {
        const ja = routes[String(a.inSystemId)]?.jumps ?? Infinity;
        const jb = routes[String(b.inSystemId)]?.jumps ?? Infinity;
        if (ja !== jb) return ja - jb;
        return byAge(a, b);
      });
    } else {
      arr.sort(byAge);
    }
    return arr;
  }, [filtered, sortBy, routes]);

  function toggleExpanded(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else              next.add(id);
      return next;
    });
  }

  // ── Copy connections into the map's signature lists ────────────────────────
  // eve-scout already knows the signature id, type and size at both ends, so
  // retyping them is busywork. Writes only into systems that are on the map.
  const activeMapId = useMapStore((st) => st.activeMapId);
  const mapSystems  = useMapStore((st) => st.map.systems);
  const [copying, setCopying] = useState(false);

  const systemsForCopy = useMemo(
    () => mapSystems.map((sy) => ({ id: sy.id, name: sy.name, eveSystemId: sy.eveSystemId })),
    [mapSystems],
  );

  const copyToMap = useCallback(async (list: typeof sorted) => {
    if (!activeMapId || copying) return;
    setCopying(true);
    try {
      // One map-wide read tells us what is already there, so a bulk copy costs
      // one request rather than one per system -- and gives us each existing
      // row's id, which is what turns this into an update rather than a
      // duplicate.
      const existing = await api<{ id: string; systemId: string; sigId: string | null }[]>(
        `/api/maps/${activeMapId}/signatures`,
      );
      const idByKey = new Map(existing.map((e) => [sigKey(e.systemId, e.sigId ?? ''), e.id]));
      const todo: SigWrite[] = allSigWrites(list, systemsForCopy, scoutSystem);

      if (todo.length === 0) { toast.info(t('scout.copyNothing')); return; }

      // Upsert. A row that is already there is brought up to date rather than
      // skipped: the feed's remaining life moves on, and a signature somebody
      // deleted by accident should come back when the button is pressed again.
      // Name and notes are left alone -- those are the scout's, not the feed's.
      const results = await Promise.allSettled(todo.map((w) => {
        const hit = idByKey.get(sigKey(w.systemId, w.sigId));
        const body = JSON.stringify(hit
          ? { whType: w.whType, whLeadsTo: w.whLeadsTo, timeStatus: w.timeStatus }
          : { sigId: w.sigId, sigType: 'wormhole', whType: w.whType,
              whLeadsTo: w.whLeadsTo, timeStatus: w.timeStatus });
        return api(
          `/api/maps/${activeMapId}/systems/${w.systemId}/signatures${hit ? `/${hit}` : ''}`,
          { method: hit ? 'PATCH' : 'POST', body },
        );
      }));

      // Draw the hole itself where both of its ends are on the map. Copying
      // the signatures without it leaves two systems sitting next to each
      // other with the exit recorded at each end and nothing joining them,
      // which is the one thing the chain is actually for.
      const store = useMapStore.getState();
      const linked = new Set(store.map.connections.map((c) => pairKey(c.sourceId, c.targetId)));
      const byId = new Map(store.map.systems.map((sy) => [sy.id, sy]));
      let connsAdded = 0;
      for (const cw of allConnWrites(list, systemsForCopy, scoutSystem)) {
        if (linked.has(pairKey(cw.fromId, cw.toId))) continue;   // already joined
        const a = byId.get(cw.fromId), b = byId.get(cw.toId);
        if (!a || !b) continue;
        const { sourceHandle, targetHandle } = pickHandles(a.position, b.position);
        // Seeded on create rather than patched afterwards: the create POST
        // waits for both endpoints to exist, so a follow-up update can reach
        // the server first and be dropped on the floor.
        store.addConnection(cw.fromId, cw.toId, sourceHandle, targetHandle, {
          connectionType: 'standard',
          type: cw.whType,
          ...(cw.size ? { size: cw.size } : null),
          ...(cw.timeStatus ? { timeStatus: cw.timeStatus } : null),
        });
        linked.add(pairKey(cw.fromId, cw.toId));
        connsAdded++;
      }

      // Tell any open pane for these systems to re-read. The live-update path
      // skips the client that made the change, so without this the signature
      // we just wrote stays invisible until the system is clicked off and on.
      const touched = new Set(todo.filter((_, i) => results[i].status === 'fulfilled')
        .map((w) => w.systemId));
      for (const id of touched) useMapStore.getState().bumpSigRev(id);

      const okFlags = results.map((r) => r.status === 'fulfilled');
      const added   = todo.filter((w, i) => okFlags[i] && !idByKey.has(sigKey(w.systemId, w.sigId))).length;
      const updated = todo.filter((w, i) => okFlags[i] &&  idByKey.has(sigKey(w.systemId, w.sigId))).length;
      const failed  = results.length - added - updated;

      if (failed > 0) toast.error(t('scout.copyPartial', { added, failed }));
      else if (connsAdded > 0) toast.success(t('scout.copyDoneLinks', { added, updated, links: connsAdded }));
      else                     toast.success(t('scout.copyDone', { added, updated }));
    } catch {
      toast.error(t('scout.copyFailed'));
    } finally {
      setCopying(false);
    }
  }, [activeMapId, copying, systemsForCopy, scoutSystem, t]);

  // How many rows a bulk copy would add, for the button's label. Cheap enough
  // to recompute: it is only the mapped ends, not a request.
  const copyableCount = useMemo(
    () => allSigWrites(sorted, systemsForCopy, scoutSystem).length,
    [sorted, systemsForCopy, scoutSystem],
  );

  if (sorted.length === 0) {
    return <div className="scout-pane__empty">{t('scout.noConnections', { system: scoutSystem })}</div>;
  }

  return (
    <div className="scout-pane">
      {origin.characterName && origin.name ? (
        <div className="scout-pane__note scout-pane__note--lastknown">{t('route.fromCharacter', { character: origin.characterName, system: aliasName(origin.name) })}</div>
      ) : origin.fromLastKnown && origin.name ? (
        <div className="scout-pane__note scout-pane__note--lastknown">{t('route.fromLastKnown', { system: aliasName(origin.name) })}</div>
      ) : null}
      <div className="scout-pane__sort">
        <label className="scout-pane__sort-label" htmlFor={`scout-sort-${scoutSystem}`}>
          {t('scout.sortLabel')}
        </label>
        <Select
          id={`scout-sort-${scoutSystem}`}
          className="scout-pane__sort-select"
          value={sortBy}
          onChange={(v) => changeSort(v as ScoutSort)}
          options={[
            { value: 'age', label: t('scout.sortAge') },
            { value: 'closest', label: t(routeMode === 'secure' ? 'scout.sortSecure' : 'scout.sortShortest') },
          ]}
        />
      </div>
      {/* Its own row, not beside the sort control: the pane is a sidebar
          column, and sharing a line with a label and a select left the button
          truncated mid-word. Disabled with a count of zero when nothing here
          touches the map, which is the common case before a chain reaches the
          hub. */}
      <div className="scout-pane__copy-row">
        <button
          type="button"
          className="sys-btn scout-pane__copy"
          onClick={() => copyToMap(sorted)}
          disabled={copying || copyableCount === 0}
          data-tooltip={t('scout.copyAllHint', { system: scoutSystem })}
        >
          {t('scout.copyAll', { count: copyableCount })}
        </button>
      </div>
      {sorted.map(c => {
        const route   = canRoute ? routes[String(c.inSystemId)] : undefined;
        const isOpen  = expanded.has(c.id);
        // The K-space exit is the destination users can autopilot to.
        // Wormhole-class targets can't be set as a waypoint.
        const isKspaceTarget = !isWormholeClass(c.inSystemClass);
        // A k-space exit stays settable even when the shortest route shortcuts
        // through a hole/Ansiblex — EVE routes there via gates regardless.
        const canAutopilot = canSetAutopilot(route);
        return (
          <div key={c.id} className={`scout-row${c.expired ? ' scout-row--expired' : ''}`}>
            <div className="scout-row__sys">
              <span className="scout-row__name">{aliasName(c.inSystemName)}</span>
              {c.inSystemClass && (
                <span
                  className="scout-row__class"
                  style={{ color: secClassColor(c.inSystemClass) }}
                >
                  {c.inSystemClass.toUpperCase()}
                </span>
              )}
              <span className="scout-row__time">{formatRemaining(t, c.remainingHours)}</span>
            </div>
            {/* A wormhole target's J-space region code carries no useful intel;
                only show the region for k-space exits. */}
            {isKspaceTarget && c.inRegionName && (
              <div className="scout-row__region">{c.inRegionName}</div>
            )}
            <div className="scout-row__meta">
              <span className="scout-row__wh">{c.whType}</span>
              <span className="scout-row__size">
                {/* Prefer the SDE-derived size from the WH type; fall back to
                    eve-scout's own maxShipSize if the type isn't in our data. */}
                {(() => {
                  const cls = whSizeForType(c.whType, whTypes);
                  return cls ? whSizeShort(cls) : (SIZE_LABELS[c.maxShipSize] ?? c.maxShipSize);
                })()}
              </span>
            </div>

            {/* Both ends of the hole, labelled. eve-scout names them from the
                hub's point of view: outSig is the signature in Thera/Turnur (the
                one you warp to in order to LEAVE), inSig is the signature in the
                system at the far end. Only inSig was shown before, which is the
                wrong one if you're sitting in the hub trying to get out. */}
            <div className="scout-row__sigs">
              <span className="scout-row__sig" title={t('scout.outSigHint', { system: scoutSystem })}>
                <span className="scout-row__sig-label">{t('scout.outSig')}</span>
                {c.outSignature || DASH}
              </span>
              <span className="scout-row__sig" title={t('scout.inSigHint', { system: aliasName(c.inSystemName) })}>
                <span className="scout-row__sig-label">{t('scout.inSig')}</span>
                {c.inSignature || DASH}
              </span>
            </div>

            <div className="scout-row__actions">
              {route && <span className="scout-row__jumps">{t('units.jumps', { count: route.jumps })}</span>}
              {/* Shown only when this connection actually touches the map --
                  a button that silently does nothing is worse than no button. */}
              {allSigWrites([c], systemsForCopy, scoutSystem).length > 0 && (
                <button
                  type="button"
                  className="sys-btn scout-row__btn scout-row__btn--icon"
                  onClick={() => copyToMap([c])}
                  disabled={copying}
                  aria-label={t('scout.copyOne')}
                  data-tooltip={t('scout.copyOne')}
                >
                  <CopyIcon size={14} weight="regular" color="#4dd9ac" />
                </button>
              )}
              {isKspaceTarget && (
                <>
                  <button
                    type="button"
                    className="sys-btn scout-row__btn scout-row__btn--icon"
                    onClick={() => setWaypoint(c.inSystemId, c.inSystemName, true)}
                    disabled={!canAutopilot}
                    aria-label={t('waypoint.setDestination')}
                    data-tooltip={canAutopilot ? t('waypoint.setDestination') : t('route.jspaceNoWaypoint')}
                  >
                    <MapPinSimpleIcon size={14} weight="regular" color="#3ddc84" />
                  </button>
                  <button
                    type="button"
                    className="sys-btn scout-row__btn scout-row__btn--icon"
                    onClick={() => setWaypoint(c.inSystemId, c.inSystemName, false)}
                    disabled={!canAutopilot}
                    aria-label={t('waypoint.addWaypoint')}
                    data-tooltip={canAutopilot ? t('waypoint.addWaypoint') : t('route.jspaceNoWaypoint')}
                  >
                    <PathIcon size={14} weight="regular" color="#5a9af8" />
                  </button>
                </>
              )}
              {/* Report the hole collapsed. It stays listed and marked rather
                  than vanishing, so a mis-flag is visible and reversible. */}
              <button
                type="button"
                className="sys-btn scout-row__btn scout-row__btn--icon"
                onClick={() => void setScoutExpired(c.id, !c.expired)}
                aria-pressed={!!c.expired}
                aria-label={t(c.expired ? 'scout.unmarkExpired' : 'scout.markExpired')}
                data-tooltip={t(c.expired ? 'scout.unmarkExpired' : 'scout.markExpired')}
              >
                <ProhibitIcon size={14} weight="regular" color={c.expired ? '#e05a5a' : '#7a90a8'} />
              </button>
              {route && (
                <button
                  type="button"
                  className="sys-btn scout-row__btn"
                  onClick={() => toggleExpanded(c.id)}
                  aria-expanded={isOpen}
                >
                  {t(isOpen ? 'a0.hideRoute' : 'a0.showRoute', {
                    mode: t(routeMode === 'secure' ? 'a0.modeSecure' : 'a0.modeShortest'),
                  })}
                </button>
              )}
            </div>

            {route && isOpen && <RouteSquares route={route} />}
          </div>
        );
      })}
    </div>
  );
}
