import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api } from '../../api/client';
import { toast } from './Toaster';
import i18n from '../../i18n';
import { truesecColor } from '../../utils/truesec';
import { ContextMenu } from './ContextMenu';
import type { RouteEntry, RoutePathNode, EdgeMeta } from '../../hooks/useRoute';

/** Fire ESI waypoint endpoint; surface success/failure via toast. */
export function setWaypoint(systemId: number, systemName: string, clear: boolean) {
  api('/api/character/waypoint', {
    method: 'POST',
    body:   JSON.stringify({ destinationId: systemId, clearOtherWaypoints: clear }),
  })
    .then(() => toast.success(clear
      ? i18n.t('routeToast.destinationSet', { system: systemName })
      : i18n.t('routeToast.waypointAdded', { system: systemName })))
    .catch(() => toast.error(i18n.t('routeToast.failed')));
}

// Human label for a shortcut hop, e.g. "Wormhole jump (EOL, critical)".
function viaLabel(t: TFunction, via: EdgeMeta): string {
  const kind = via.kind === 'thera'  ? t('route.viaThera')
             : via.kind === 'turnur' ? t('route.viaTurnur')
             :                         t('route.viaWormhole');
  const risks = [
    via.eol      && t('route.riskEol'),
    via.critical && t('route.riskCritical'),
    via.frig     && t('route.riskFrig'),
  ].filter(Boolean);
  return risks.length ? `${kind} (${risks.join(', ')})` : kind;
}

/**
 * Wrap-friendly row of coloured squares, one per system on the path. A shortcut
 * hop (wormhole / Thera / Turnur) is drawn as a diamond marker in the gap before
 * the square it leads into. Right-clicking a k-space square offers set
 * destination / add waypoint to that system — the way to autopilot toward a
 * route that itself can't be pushed to the in-game autopilot.
 */
export function RouteSquares({ route }: { route: RouteEntry }) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ x: number; y: number; node: RoutePathNode } | null>(null);

  return (
    <div className="scout-route">
      {route.path.map((sys, i) => (
        <Fragment key={`${sys.id}-${i}`}>
          {sys.via && (
            <span
              className={`scout-route__link${(sys.via.eol || sys.via.critical) ? ' scout-route__link--risk' : ''}`}
              data-tooltip={viaLabel(t, sys.via)}
              aria-label={viaLabel(t, sys.via)}
            />
          )}
          <span
            className={`scout-route__square${sys.kspace ? ' scout-route__square--kspace' : ''}`}
            style={{ background: truesecColor(sys.security) }}
            data-tooltip={`${sys.name} ${sys.security.toFixed(1)}`}
            aria-label={`${sys.name} ${sys.security.toFixed(1)}`}
            onContextMenu={sys.kspace
              ? (e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, node: sys }); }
              : undefined}
          />
        </Fragment>
      ))}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { label: t('waypoint.setDestination'), action: () => setWaypoint(menu.node.id, menu.node.name, true) },
            { label: t('waypoint.addWaypoint'),    action: () => setWaypoint(menu.node.id, menu.node.name, false) },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** K-space classes from which a stargate route can be computed. */
export const KSPACE_CLASSES = new Set(['HS', 'LS', 'NS', 'Pochven']);
