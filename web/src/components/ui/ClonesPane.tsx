import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useClones } from '../../hooks/useClones';
import { useRoute } from '../../hooks/useRoute';
import { useRouteOrigin } from '../../hooks/useRouteOrigin';
import { useSystemAlias } from '../../hooks/useSystemAlias';
import { CLASS_COLORS } from '../../data/wormholes';
import type { SystemClass } from '../../types';
import { jumps as jumpsLabel } from '../../i18n/format';
import { DASH } from '../../i18n/format';
import { setWaypoint, canSetAutopilot } from './routeUi';
import { MapPinSimpleIcon, PathIcon, CaretDownIcon, CaretRightIcon } from '../../icons';
import type { Implant } from '../../hooks/useClones';

// Where this pilot's clones are, and how far each is from where they're standing.
// Medical clone first — it's the one that decides where you wake up — then jump
// clones in the order ESI returns them.
export function ClonesPane() {
  const { t } = useTranslation();
  const clones = useClones();
  const aliasName = useSystemAlias();
  const origin = useRouteOrigin();

  // Which clones have their implant list expanded.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const rows = useMemo(() => [
    // The medical clone carries no implant list: it's where you RESPAWN, and a
    // fresh clone has none. Implants live in the body you're flying, which is a
    // different endpoint and a scope we deliberately don't request.
    ...(clones.home ? [{ key: 'home', label: t('clones.medical'), system: clones.home, implants: [] as Implant[] }] : []),
    ...clones.jumpClones.map((jc) => ({
      key: `jc-${jc.id}`,
      label: jc.name || t('clones.jumpClone'),
      system: jc.system,
      implants: jc.implants,
    })),
  ], [clones, t]);

  const targetIds = useMemo(
    () => rows.map((r) => r.system?.eveSystemId).filter((x): x is number => x != null),
    [rows],
  );
  const routes = useRoute(origin.systemId, targetIds);

  // Nothing to show for two different reasons, and they need different words:
  // the deployment never asked for the scope, versus it did and this character
  // has no clones (or hasn't re-authorised yet).
  if (!clones.enabled) {
    return <div className="scout-pane__empty">{t('clones.notEnabled')}</div>;
  }
  if (rows.length === 0) {
    return <div className="scout-pane__empty">{t('clones.none')}</div>;
  }

  return (
    <div className="fleet-pane">
      <ul className="fleet-pane__list">
        {rows.map((r) => {
          const sys = r.system;
          const route = sys ? routes[String(sys.eveSystemId)] : undefined;
          const color = sys?.systemClass ? CLASS_COLORS[sys.systemClass as SystemClass] : undefined;
          // Same rule the scout pane uses: a wormhole-class destination can't be
          // an autopilot waypoint, and neither can a clone we couldn't resolve.
          const canAutopilot = !!sys && canSetAutopilot(route);
          const isOpen = open.has(r.key);
          return (
            <li key={r.key} className="pilots-card">
              <div className="pilots-card__body">
                <div className="pilots-card__name" title={r.label}>{r.label}</div>
                <div className="pilots-card__ship">
                  {/* An unresolved location means the clone sits in a structure
                      this character can no longer see — say so rather than
                      showing a blank where a system should be. */}
                  {sys?.name
                    ? <span style={color ? { color } : undefined}>{aliasName(sys.name)}</span>
                    : t('clones.unknownLocation')}
                  {sys?.regionName && <span className="pilots-card__region"> {sys.regionName}</span>}
                </div>

                <div className="pilots-card__line">
                  {/* Implant count doubles as the disclosure control when there's
                      something to disclose; a clone with none is plain text so
                      it doesn't invite a click that would open nothing. */}
                  {r.implants.length > 0 ? (
                    <button
                      type="button"
                      className="clones-card__implant-toggle"
                      onClick={() => toggle(r.key)}
                      aria-expanded={isOpen}
                    >
                      {isOpen
                        ? <CaretDownIcon size={11} weight="bold" />
                        : <CaretRightIcon size={11} weight="bold" />}
                      {t('clones.implants', { count: r.implants.length })}
                    </button>
                  ) : (
                    <span className="pilots-card__loc">
                      {r.key === 'home' ? DASH : t('clones.implants', { count: 0 })}
                    </span>
                  )}
                  <span className="pilots-card__age">
                    {route ? jumpsLabel(t, route.jumps) : DASH}
                  </span>
                </div>

                {isOpen && (
                  <ul className="clones-card__implants">
                    {r.implants.map((im) => (
                      <li key={im.typeId} title={im.name}>{im.name}</li>
                    ))}
                  </ul>
                )}

                {sys && (
                  <div className="clones-card__actions">
                    <button
                      type="button"
                      className="sys-btn scout-row__btn scout-row__btn--icon"
                      onClick={() => setWaypoint(sys.eveSystemId, sys.name ?? '', true)}
                      disabled={!canAutopilot}
                      aria-label={t('waypoint.setDestination')}
                      data-tooltip={canAutopilot ? t('waypoint.setDestination') : t('route.jspaceNoWaypoint')}
                    >
                      <MapPinSimpleIcon size={14} weight="regular" color="#3ddc84" />
                    </button>
                    <button
                      type="button"
                      className="sys-btn scout-row__btn scout-row__btn--icon"
                      onClick={() => setWaypoint(sys.eveSystemId, sys.name ?? '', false)}
                      disabled={!canAutopilot}
                      aria-label={t('waypoint.addWaypoint')}
                      data-tooltip={canAutopilot ? t('waypoint.addWaypoint') : t('route.jspaceNoWaypoint')}
                    >
                      <PathIcon size={14} weight="regular" color="#5a9af8" />
                    </button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
