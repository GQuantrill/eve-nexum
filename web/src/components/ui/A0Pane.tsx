import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPinSimpleIcon, PathIcon } from '@phosphor-icons/react';
import { jumps } from '../../i18n/format';
import { useA0Systems } from '../../hooks/useA0Systems';
import { useCharacterLocation } from '../../hooks/useCharacterLocation';
import { useRoute } from '../../hooks/useRoute';
import { setWaypoint, RouteSquares, KSPACE_CLASSES } from './routeUi';
import { useMapStore } from '../../store/mapStore';

const TOP_N = 10;

export function A0Pane() {
  const { t } = useTranslation();
  const all      = useA0Systems();
  const routeMode = useMapStore((s) => s.routeMode);
  const location = useCharacterLocation();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const canRoute =
    location.online &&
    location.system !== null &&
    KSPACE_CLASSES.has(location.system.systemClass);

  const targetIds = useMemo(() => all.map(s => s.id), [all]);
  const routes = useRoute(canRoute ? location.system!.eveSystemId : null, targetIds);

  const closest = useMemo(() => {
    if (!canRoute) return [];
    return all
      .map(s => ({ ...s, jumps: routes[String(s.id)]?.jumps ?? Infinity }))
      .filter(s => Number.isFinite(s.jumps))
      .sort((a, b) => a.jumps - b.jumps)
      .slice(0, TOP_N);
  }, [all, routes, canRoute]);

  function toggleExpanded(id: number) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else              next.add(id);
      return next;
    });
  }

  if (!canRoute) {
    return (
      <div className="scout-pane__empty">
        Sign in and dock in K-space to see nearby A0 systems.
      </div>
    );
  }

  if (all.length === 0 || (closest.length === 0 && Object.keys(routes).length === 0)) {
    return <div className="scout-pane__empty">Computing routes…</div>;
  }

  if (closest.length === 0) {
    return <div className="scout-pane__empty">No A0 systems reachable.</div>;
  }

  return (
    <div className="scout-pane">
      <div className="scout-pane__note">Showing the {TOP_N} closest A0 systems.</div>
      {closest.map(s => {
        const route   = routes[String(s.id)];
        const isOpen  = expanded.has(s.id);
        return (
          <div key={s.id} className="scout-row">
            <div className="scout-row__sys">
              <span className="scout-row__name">{s.name}</span>
              <span className="scout-row__class scout-row__class--a0">A0</span>
            </div>
            <div className="scout-row__region">{s.regionName}</div>

            <div className="scout-row__actions">
              <span className="scout-row__jumps">{jumps(t, s.jumps)}</span>
              <button
                type="button"
                className="sys-btn scout-row__btn scout-row__btn--icon"
                onClick={() => setWaypoint(s.id, s.name, true)}
                aria-label="Set Destination"
                data-tooltip="Set Destination"
              >
                <MapPinSimpleIcon size={14} weight="regular" color="#3ddc84" />
              </button>
              <button
                type="button"
                className="sys-btn scout-row__btn scout-row__btn--icon"
                onClick={() => setWaypoint(s.id, s.name, false)}
                aria-label="Add Waypoint"
                data-tooltip="Add Waypoint"
              >
                <PathIcon size={14} weight="regular" color="#5a9af8" />
              </button>
              {route && (
                <button
                  type="button"
                  className="sys-btn scout-row__btn"
                  onClick={() => toggleExpanded(s.id)}
                  aria-expanded={isOpen}
                >
                  {isOpen ? `Hide ${routeMode} route` : `Show ${routeMode} route`}
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
