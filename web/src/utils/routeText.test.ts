import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { routeText } from './routeText';
import type { RoutePathNode, EdgeMeta } from '../hooks/useRoute';

const t = ((k: string) => k.replace('route.', '')) as unknown as TFunction;
const node = (name: string, via?: EdgeMeta): RoutePathNode => ({ id: 1, name, security: 0.5, kspace: true, via });
const route = (...path: RoutePathNode[]) => ({ jumps: path.length - 1, path, usesSpecial: true });

describe('routeText', () => {
  it('lists every system, naming holes by signature', () => {
    expect(routeText(t, route(
      node('M-0EE8'),
      node('J123456', { kind: 'wormhole', sig: 'ABC-123' }),
      node('Mastakomon', { kind: 'wormhole', sig: 'DEF-456', eol: true, critical: true }),
      node('Sobaseki'), node('Jita'),
    ))).toBe('M-0EE8 -(ABC-123)-> J123456 -(DEF-456 copyEol copyCrit)-> Mastakomon -> Sobaseki -> Jita');
  });

  it('puts an alias in brackets after the real name', () => {
    const alias = (n: string) => (n === 'J123456' ? 'Home' : n);
    expect(routeText(t, route(node('Sosa'), node('J123456', { kind: 'wormhole', sig: 'ABC-123' })), alias))
      .toBe('Sosa -(ABC-123)-> J123456 (Home)');
  });

  it('falls back to the hole type, then the kind of hop', () => {
    expect(routeText(t, route(
      node('Amarr'), node('Sarum Prime'),
      node('X', { kind: 'ansiblex' }),
      node('Thera', { kind: 'thera' }),
      node('J1', { kind: 'wormhole', whType: 'H296', frig: true }),
    ))).toBe('Amarr -> Sarum Prime -(copyAnsiblex)-> X -(viaThera)-> Thera -(H296 copyFrig)-> J1');
  });

  it('is just the name for a route of one system, and nothing for none', () => {
    expect(routeText(t, route(node('Jita')))).toBe('Jita');
    expect(routeText(t, { jumps: 0, path: [], usesSpecial: false })).toBe('');
  });
});
