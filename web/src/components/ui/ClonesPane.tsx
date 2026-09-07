import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useClones } from '../../hooks/useClones';
import { useRoute } from '../../hooks/useRoute';
import { useRouteOrigin } from '../../hooks/useRouteOrigin';
import { useSystemAlias } from '../../hooks/useSystemAlias';
import { CLASS_COLORS } from '../../data/wormholes';
import type { SystemClass } from '../../types';
import { jumps as jumpsLabel } from '../../i18n/format';
import { DASH } from '../../i18n/format';

// Where this pilot's clones are, and how far each is from where they're standing.
// Medical clone first — it's the one that decides where you wake up — then jump
// clones in the order ESI returns them.
export function ClonesPane() {
  const { t } = useTranslation();
  const clones = useClones();
  const aliasName = useSystemAlias();
  const origin = useRouteOrigin();

  const rows = useMemo(() => [
    ...(clones.home ? [{ key: 'home', label: t('clones.medical'), system: clones.home, implants: null as number | null }] : []),
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
                  <span className="pilots-card__loc">
                    {r.implants != null ? t('clones.implants', { count: r.implants }) : DASH}
                  </span>
                  <span className="pilots-card__age">
                    {route ? jumpsLabel(t, route.jumps) : DASH}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
