import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useScoutConnections } from '../../hooks/useScoutConnections';
import { useWormholeTypes } from '../../hooks/useWormholeTypes';
import { whSizeForType, whSizeShort } from '../../utils/wormholeSize';
import { useRouteOrigin } from '../../hooks/useRouteOrigin';
import { useRoute } from '../../hooks/useRoute';
import { setWaypoint, RouteSquares } from './routeUi';
import { truesecColor } from '../../utils/truesec';
import { useMapStore } from '../../store/mapStore';
import { MapPinSimpleIcon, PathIcon } from '@phosphor-icons/react';

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

function formatRemaining(t: TFunction, hours: number): string {
  if (hours <= 0) return t('scout.expiring');
  if (hours < 1)  return '<1h';
  return `${Math.floor(hours)}h`;
}

export function ScoutConnectionsPane({ scoutSystem }: Props) {
  const { t }    = useTranslation();
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
  const routes = useRoute(origin.systemId, targetIds);

  // Two sort modes:
  //  - 'age'     : remaining time descending — freshest holes at the top, the
  //                soon-to-collapse ones drop to the bottom.
  //  - 'closest' : fewest jumps via the active route preference (shortest /
  //                secure) ascending. Connections without a usable route (no
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

  if (sorted.length === 0) {
    return <div className="scout-pane__empty">{t('scout.noConnections', { system: scoutSystem })}</div>;
  }

  return (
    <div className="scout-pane">
      {origin.characterName && origin.name ? (
        <div className="scout-pane__note scout-pane__note--lastknown">{t('route.fromCharacter', { character: origin.characterName, system: origin.name })}</div>
      ) : origin.fromLastKnown && origin.name ? (
        <div className="scout-pane__note scout-pane__note--lastknown">{t('route.fromLastKnown', { system: origin.name })}</div>
      ) : null}
      <div className="scout-pane__sort">
        <label className="scout-pane__sort-label" htmlFor={`scout-sort-${scoutSystem}`}>
          {t('scout.sortLabel')}
        </label>
        <select
          id={`scout-sort-${scoutSystem}`}
          className="scout-pane__sort-select"
          value={sortBy}
          onChange={(e) => changeSort(e.target.value as ScoutSort)}
        >
          <option value="age">{t('scout.sortAge')}</option>
          <option value="closest">
            {t(routeMode === 'secure' ? 'scout.sortSecure' : 'scout.sortShortest')}
          </option>
        </select>
      </div>
      {sorted.map(c => {
        const route   = canRoute ? routes[String(c.inSystemId)] : undefined;
        const isOpen  = expanded.has(c.id);
        // The K-space exit is the destination users can autopilot to.
        // Wormhole-class targets can't be set as a waypoint.
        const isKspaceTarget = !isWormholeClass(c.inSystemClass);
        return (
          <div key={c.id} className="scout-row">
            <div className="scout-row__sys">
              <span className="scout-row__name">{c.inSystemName}</span>
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
            <div className="scout-row__region">{c.inRegionName}</div>
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
              <span className="scout-row__sig">{c.inSignature}</span>
            </div>

            <div className="scout-row__actions">
              {route && <span className="scout-row__jumps">{t('units.jumps', { count: route.jumps })}</span>}
              {isKspaceTarget && (
                <>
                  <button
                    type="button"
                    className="sys-btn scout-row__btn scout-row__btn--icon"
                    onClick={() => setWaypoint(c.inSystemId, c.inSystemName, true)}
                    aria-label={t('waypoint.setDestination')}
                    data-tooltip={t('waypoint.setDestination')}
                  >
                    <MapPinSimpleIcon size={14} weight="regular" color="#3ddc84" />
                  </button>
                  <button
                    type="button"
                    className="sys-btn scout-row__btn scout-row__btn--icon"
                    onClick={() => setWaypoint(c.inSystemId, c.inSystemName, false)}
                    aria-label={t('waypoint.addWaypoint')}
                    data-tooltip={t('waypoint.addWaypoint')}
                  >
                    <PathIcon size={14} weight="regular" color="#5a9af8" />
                  </button>
                </>
              )}
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
