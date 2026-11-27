import type { TFunction } from 'i18next';
import type { RouteEntry } from '../hooks/useRoute';

/**
 * A route as one line of plain text, to paste to people who don't use nexum:
 *
 *   M-0EE8 -(ABC-123)-> J123456 -(DEF-456 EOL)-> Mastakomon -(12 jumps)-> Jita
 *
 * Each shortcut hop is named by the signature to warp to in the system it
 * leaves (else the hole's type, else what kind of hop it is), with EOL /
 * critical / frigate flags. A run of stargate jumps collapses to its count:
 * the in-game autopilot plots those, and a 20-name gate list in chat only
 * hides the holes that matter. Real system names, not this map's aliases:
 * the reader has never seen the map.
 */
export function routeText(t: TFunction, route: RouteEntry): string {
  const path = route.path;
  if (path.length === 0) return '';
  let out = path[0].name;
  let gates = 0;
  const flushGates = (to: string) => {
    out += ` -(${t('units.jumps', { count: gates })})-> ${to}`;
    gates = 0;
  };
  for (let i = 1; i < path.length; i++) {
    const node = path[i];
    const via = node.via;
    if (!via) {
      gates++;
      // Close the run where the next hop isn't a gate, or the route ends.
      if (i === path.length - 1 || path[i + 1].via) flushGates(node.name);
      continue;
    }
    const name = via.sig || via.whType || t(
      via.kind === 'thera' ? 'route.viaThera'
      : via.kind === 'turnur' ? 'route.viaTurnur'
      : via.kind === 'ansiblex' ? 'route.copyAnsiblex'
      : 'route.copyWormhole');
    const flags = [
      via.eol && t('route.copyEol'),
      via.critical && t('route.copyCrit'),
      via.frig && t('route.copyFrig'),
    ].filter(Boolean);
    out += ` -(${[name, ...flags].join(' ')})-> ${node.name}`;
  }
  return out;
}
