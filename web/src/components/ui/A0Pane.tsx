import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPinSimpleIcon, PathIcon } from '@phosphor-icons/react';
import { jumps } from '../../i18n/format';
import { useA0Systems } from '../../hooks/useA0Systems';
import { useRouteOrigin } from '../../hooks/useRouteOrigin';
import { useRoute } from '../../hooks/useRoute';
import { setWaypoint, RouteSquares } from './routeUi';
import { useMapStore } from '../../store/mapStore';

const TOP_N = 10;

export function A0Pane() {
  const { t } = useTranslation();
  const all      = useA0Systems();
  const routeMode = useMapStore((s) => s.routeMode);
  const origin   = useRouteOrigin();
  const canRoute = origin.systemId !== null;
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const targetIds = useMemo(() => all.map(s => s.id), [all]);
  const routes = useRoute(origin.systemId, targetIds);

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
        {t('a0.signIn')}
      </div>
    );
  }

  if (all.length === 0 || (closest.length === 0 && Object.keys(routes).length === 0)) {
    return <div className="scout-pane__empty">{t('a0.computing')}</div>;
  }

  if (closest.length === 0) {
    return <div className="scout-pane__empty">{t('a0.noneReachable')}</div>;
  }

  return (
    <div className="scout-pane">
      {origin.characterName && origin.name ? (
        <div className="scout-pane__note scout-pane__note--lastknown">{t('route.fromCharacter', { character: origin.characterName, system: origin.name })}</div>
      ) : origin.fromLastKnown && origin.name ? (
        <div className="scout-pane__note scout-pane__note--lastknown">{t('route.fromLastKnown', { system: origin.name })}</div>
      ) : null}
      <div className="scout-pane__note">{t('a0.showing', { count: TOP_N })}</div>
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
                aria-label={t('waypoint.setDestination')}
                data-tooltip={t('waypoint.setDestination')}
              >
                <MapPinSimpleIcon size={14} weight="regular" color="#3ddc84" />
              </button>
              <button
                type="button"
                className="sys-btn scout-row__btn scout-row__btn--icon"
                onClick={() => setWaypoint(s.id, s.name, false)}
                aria-label={t('waypoint.addWaypoint')}
                data-tooltip={t('waypoint.addWaypoint')}
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
                  {(() => {
                    const mode = routeMode === 'secure' ? t('a0.modeSecure') : t('a0.modeShortest');
                    return isOpen ? t('a0.hideRoute', { mode }) : t('a0.showRoute', { mode });
                  })()}
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
