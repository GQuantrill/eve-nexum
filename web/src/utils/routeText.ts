import type { TFunction } from 'i18next';
import type { RouteEntry } from '../hooks/useRoute';

/**
 * A route as one line of plain text, to paste to people who don't use nexum.
 * Every system on the way, in order: a stargate jump is a plain arrow, a
 * shortcut names how to take it:
 *
 *   M-0EE8 -(ABC-123)-> J123456 (Home) -(DEF-456 EOL)-> Mastakomon -> Sobaseki -> Jita
 *
 * A shortcut hop is named by the signature to warp to in the system it leaves
 * (else the hole's type, else what kind of hop it is), with EOL / critical /
 * frigate flags. Real system names, since that's what the reader can find in
 * game, with this map's alias after in brackets where one is set.
 */
export function routeText(
  t: TFunction,
  route: RouteEntry,
  aliasOf: (name: string) => string = (n) => n,
): string {
  const label = (name: string) => {
    const alias = aliasOf(name);
    return alias && alias !== name ? `${name} (${alias})` : name;
  };
  return route.path.map((node, i) => {
    if (i === 0) return label(node.name);
    const via = node.via;
    if (!via) return ` -> ${label(node.name)}`;
    const how = via.sig || via.whType || t(
      via.kind === 'thera' ? 'route.viaThera'
      : via.kind === 'turnur' ? 'route.viaTurnur'
      : via.kind === 'ansiblex' ? 'route.copyAnsiblex'
      : 'route.copyWormhole');
    const flags = [
      via.eol && t('route.copyEol'),
      via.critical && t('route.copyCrit'),
      via.frig && t('route.copyFrig'),
    ].filter(Boolean);
    return ` -(${[how, ...flags].join(' ')})-> ${label(node.name)}`;
  }).join('');
}
