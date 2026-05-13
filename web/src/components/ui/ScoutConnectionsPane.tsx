import { useMemo, useState } from 'react';
import { useScoutConnections } from '../../hooks/useScoutConnections';
import { useCharacterLocation } from '../../hooks/useCharacterLocation';
import { useRoute } from '../../hooks/useRoute';
import { setWaypoint, RouteSquares, KSPACE_CLASSES } from './routeUi';

interface Props {
  scoutSystem: 'Thera' | 'Turnur';
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

function formatRemaining(hours: number): string {
  if (hours <= 0) return 'expiring';
  if (hours < 1)  return '<1h';
  return `${Math.floor(hours)}h`;
}

export function ScoutConnectionsPane({ scoutSystem }: Props) {
  const all      = useScoutConnections();
  const location = useCharacterLocation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const filtered = useMemo(
    () => all.filter(c => c.outSystemName === scoutSystem),
    [all, scoutSystem],
  );

  const canRoute =
    location.online &&
    location.system !== null &&
    KSPACE_CLASSES.has(location.system.systemClass);

  const targetIds = useMemo(() => filtered.map(c => c.inSystemId), [filtered]);
  const routes = useRoute(canRoute ? location.system!.eveSystemId : null, targetIds);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    if (!canRoute) {
      arr.sort((a, b) => a.inSystemName.localeCompare(b.inSystemName));
      return arr;
    }
    arr.sort((a, b) => {
      const ja = routes[String(a.inSystemId)]?.jumps ?? Infinity;
      const jb = routes[String(b.inSystemId)]?.jumps ?? Infinity;
      if (ja !== jb) return ja - jb;
      return a.inSystemName.localeCompare(b.inSystemName);
    });
    return arr;
  }, [filtered, routes, canRoute]);

  function toggleExpanded(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else              next.add(id);
      return next;
    });
  }

  if (sorted.length === 0) {
    return <div className="scout-pane__empty">No {scoutSystem} connections.</div>;
  }

  return (
    <div className="scout-pane">
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
                <span className="scout-row__class">{c.inSystemClass.toUpperCase()}</span>
              )}
              <span className="scout-row__time">{formatRemaining(c.remainingHours)}</span>
            </div>
            <div className="scout-row__region">{c.inRegionName}</div>
            <div className="scout-row__meta">
              <span className="scout-row__wh">{c.whType}</span>
              <span className="scout-row__size">
                {SIZE_LABELS[c.maxShipSize] ?? c.maxShipSize}
              </span>
              <span className="scout-row__sig">{c.inSignature}</span>
            </div>

            <div className="scout-row__actions">
              {route && <span className="scout-row__jumps">{route.jumps} jumps</span>}
              {isKspaceTarget && (
                <>
                  <button
                    type="button"
                    className="sys-btn scout-row__btn"
                    onClick={() => setWaypoint(c.inSystemId, c.inSystemName, true)}
                  >
                    Set Destination
                  </button>
                  <button
                    type="button"
                    className="sys-btn scout-row__btn"
                    onClick={() => setWaypoint(c.inSystemId, c.inSystemName, false)}
                  >
                    + Waypoint
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
                  {isOpen ? 'Hide route' : 'Show route'}
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
