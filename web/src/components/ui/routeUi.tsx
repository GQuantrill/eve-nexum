import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { truesecColor } from '../../utils/truesec';
import { setWaypoint } from '../../utils/routeActions';
import { ContextMenu } from './ContextMenu';
import { useSystemAlias } from '../../hooks/useSystemAlias';
import type { RouteEntry, RoutePathNode, EdgeMeta } from '../../hooks/useRoute';
import type { RouteOrigin } from '../../hooks/useRouteOrigin';
import { useMapStore } from '../../store/mapStore';

/** Where a route pane's jumps are counted from, when that isn't simply where
 *  the pilot is: a system picked with "Route from here" (with a way to stop),
 *  another character, or a last known location. Plus a line when a picked
 *  origin couldn't be routed from and the pilot's own location was used. */
export function RouteOriginNote({ origin }: { origin: RouteOrigin }) {
  const { t } = useTranslation();
  const aliasName = useSystemAlias();
  const clearPinned = useMapStore((s) => s.setRouteFromSystem);
  return (
    <>
      {origin.skipped && (
        <div className="scout-pane__note">{t('route.originSkipped', { name: aliasName(origin.skipped) })}</div>
      )}
      {origin.pinnedSystem && origin.name ? (
        <div className="scout-pane__note scout-pane__note--lastknown scout-pane__note--pinned">
          <span>{t('route.fromPinned', { system: aliasName(origin.name) })}</span>
          <button type="button" className="sys-btn scout-row__btn" onClick={() => clearPinned(null)}>{t('route.clearPinned')}</button>
        </div>
      ) : origin.characterName && origin.name ? (
        <div className="scout-pane__note scout-pane__note--lastknown">{t('route.fromCharacter', { character: origin.characterName, system: aliasName(origin.name) })}</div>
      ) : origin.fromLastKnown && origin.name ? (
        <div className="scout-pane__note scout-pane__note--lastknown">{t('route.fromLastKnown', { system: aliasName(origin.name) })}</div>
      ) : null}
    </>
  );
}



// Human label for a shortcut hop, e.g. "Wormhole jump (EOL, critical)".
function viaLabel(t: TFunction, via: EdgeMeta): string {
  const kind = via.kind === 'thera'    ? t('route.viaThera')
             : via.kind === 'turnur'   ? t('route.viaTurnur')
             : via.kind === 'ansiblex' ? t('route.viaAnsiblex')
             :                           t('route.viaWormhole');
  const risks = [
    via.eol      && t('route.riskEol'),
    via.critical && t('route.riskCritical'),
    via.frig     && t('route.riskFrig'),
  ].filter(Boolean);
  const label = risks.length ? `${kind} (${risks.join(', ')})` : kind;
  // Name the map a chain hop came from. Closest Systems routes across every
  // map at once, so without this a hole from a map you are not looking at is
  // indistinguishable from one in the chain on screen. Scout hubs carry no
  // map — they come from the public feed.
  return via.mapName ? `${label} — ${t('route.viaMap', { map: via.mapName })}` : label;
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
  const aliasName = useSystemAlias();
  const [menu, setMenu] = useState<{ x: number; y: number; node: RoutePathNode } | null>(null);

  return (
    <div className="scout-route">
      {route.path.map((sys, i) => (
        <Fragment key={`${sys.id}-${i}`}>
          {sys.via && (
            <span
              className={`scout-route__link${
                sys.via.kind === 'ansiblex' ? ' scout-route__link--ansiblex' : ''
              }${(sys.via.eol || sys.via.critical) ? ' scout-route__link--risk' : ''}`}
              data-tooltip={viaLabel(t, sys.via)}
              aria-label={viaLabel(t, sys.via)}
            />
          )}
          <span
            className={`scout-route__square${sys.kspace ? ' scout-route__square--kspace' : ''}`}
            style={{ background: truesecColor(sys.security) }}
            data-tooltip={`${aliasName(sys.name)} ${sys.security.toFixed(1)}`}
            aria-label={`${aliasName(sys.name)} ${sys.security.toFixed(1)}`}
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

