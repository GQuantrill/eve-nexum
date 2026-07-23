import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useMapStore } from '../store/mapStore';
import { useUserSetting } from './useUserSetting';

// Metadata for a shortcut hop (wormhole chain link / Thera / Turnur scout
// connection) — mirrors the server EdgeMeta, used to mark the gap between two
// route squares and flag risky holes.
export interface EdgeMeta {
  kind:      'wormhole' | 'thera' | 'turnur' | 'ansiblex';
  eol?:      boolean;
  critical?: boolean;
  frig?:     boolean;
  whType?:   string;
}

export interface RoutePathNode {
  id:       number;
  name:     string;
  security: number;
  kspace:   boolean;    // in the stargate graph → can be an autopilot destination
  via?:     EdgeMeta;   // set when the hop INTO this node was a shortcut
}

export interface RouteEntry {
  jumps:       number;
  path:        RoutePathNode[];
  usesSpecial: boolean;  // path traverses a wormhole/Thera/Turnur/Ansiblex hop (informational — the
                         // displayed route won't match EVE autopilot; a k-space destination is still settable)
}

/**
 * Fetch shortest-route jump count + path from `from` to each of `targets`.
 * Routing mode is read from the user prefs store ('shortest' for fewest jumps,
 * 'secure' for HS-preferring Dijkstra). Three opt-in toggles splice shortcut
 * edges into the graph: Thera / Turnur scout connections and mapped wormhole
 * chains. JSON object keys are strings, so callers look up via
 * `routes[String(id)]`.
 *
 * `whScope` decides which maps' wormhole/Ansiblex chains are spliced in:
 *   - 'active' (default): only the active map — for panes tied to the current
 *     chain (A0, scout connections, fleet, proximity).
 *   - 'all': every map the user can see, unioned server-side — for the Closest
 *     Systems pane, a per-user tool where the chain you're actually in should
 *     route regardless of which tab is active.
 */
export function useRoute(
  from: number | null,
  targets: number[],
  whScope: 'active' | 'all' = 'active',
): Record<string, RouteEntry> {
  const [data, setData] = useState<Record<string, RouteEntry>>({});
  const routeMode   = useMapStore((s) => s.routeMode);
  const activeMapId = useMapStore((s) => s.activeMapId);
  const [inclThera]     = useUserSetting<boolean>('nexum.route.includeThera', false);
  const [inclTurnur]    = useUserSetting<boolean>('nexum.route.includeTurnur', false);
  const [inclWormholes] = useUserSetting<boolean>('nexum.route.includeWormholes', false);
  const [inclAnsiblex]  = useUserSetting<boolean>('nexum.route.includeAnsiblex', false);

  const allScope = whScope === 'all';
  const targetsKey = [...targets].sort((a, b) => a - b).join(',');
  // In 'all' scope the server resolves the map set itself, so no active map is
  // required — the chains still apply when routing from another region's tab.
  const wantWh   = inclWormholes && (allScope || !!activeMapId);
  const wantAnsi = inclAnsiblex  && (allScope || !!activeMapId);

  useEffect(() => {
    if (!from || !targetsKey) {
      setData({});
      return;
    }
    let cancelled = false;
    let url = `/api/route?from=${from}&to=${targetsKey}&mode=${routeMode}`;
    if (inclThera)  url += '&includeThera=true';
    if (inclTurnur) url += '&includeTurnur=true';
    if (wantWh)     url += '&includeWormholes=true';
    if (wantAnsi)   url += '&includeAnsiblex=true';
    if (wantWh || wantAnsi) url += allScope ? '&whScope=all' : `&mapId=${activeMapId}`;
    api<Record<string, RouteEntry>>(url)
      .then(r => { if (!cancelled) setData(r); })
      .catch(() => { if (!cancelled) setData({}); });
    return () => { cancelled = true; };
  }, [from, targetsKey, routeMode, inclThera, inclTurnur, wantWh, wantAnsi, allScope, activeMapId]);

  return data;
}
