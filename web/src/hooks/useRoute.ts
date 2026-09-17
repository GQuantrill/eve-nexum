import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useMapStore } from '../store/mapStore';
import { useUserSetting } from './useUserSetting';
import { useScoutFlagRevision } from './useScoutConnections';

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
 *
 * `viaScout` forces one scout hub's shortcut edges ON regardless of the user's
 * route settings, for the pane that lists that hub's exits. Reaching a Turnur
 * exit means going through Turnur, so a route that refuses to use the hole
 * describes a journey nobody would make — it was sending people the long way
 * round, or through the *other* hub entirely. The other hub still follows the
 * user's own setting, as do mapped chains and Ansiblex bridges.
 *
 * The trade: most rows become "distance to the hub, plus the hole", so they
 * bunch together and the shortest-route sort separates them less than it did.
 * A number that describes the actual trip is worth more than a spread.
 */
export function useRoute(
  from: number | null,
  targets: number[],
  whScope: 'active' | 'all' = 'active',
  opts: { viaScout?: 'thera' | 'turnur' } = {},
): Record<string, RouteEntry> {
  const [data, setData] = useState<Record<string, RouteEntry>>({});
  const routeMode   = useMapStore((s) => s.routeMode);
  const activeMapId = useMapStore((s) => s.activeMapId);
  const [inclThera]     = useUserSetting<boolean>('nexum.route.includeThera', false);
  const [inclTurnur]    = useUserSetting<boolean>('nexum.route.includeTurnur', false);
  const [inclWormholes] = useUserSetting<boolean>('nexum.route.includeWormholes', false);
  const [inclAnsiblex]  = useUserSetting<boolean>('nexum.route.includeAnsiblex', false);
  // Bumped when a scout connection is flagged/unflagged collapsed. The server
  // reads the flags, but they're invisible to this request's inputs, so without
  // this the stale route would stand.
  const flagRevision = useScoutFlagRevision();

  const allScope = whScope === 'all';
  const targetsKey = [...targets].sort((a, b) => a - b).join(',');
  // A scout pane's own hub always counts: you're looking at Turnur's holes, so
  // the trip through one of them is the trip. The OTHER hub follows the user's
  // route settings, so a route only borrows a shortcut they've opted into.
  const wantThera  = inclThera  || opts.viaScout === 'thera';
  const wantTurnur = inclTurnur || opts.viaScout === 'turnur';
  // In 'all' scope the server resolves the map set itself, so no active map is
  // required — the chains still apply when routing from another region's tab.
  const wantWh   = inclWormholes && (allScope || !!activeMapId);
  const wantAnsi = inclAnsiblex  && (allScope || !!activeMapId);

  useEffect(() => {
    if (!from || !targetsKey) {
      // Deliberate: clears this pane's own state when the record it shows changes.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setData({});
      return;
    }
    let cancelled = false;
    let url = `/api/route?from=${from}&to=${targetsKey}&mode=${routeMode}`;
    if (wantThera)  url += '&includeThera=true';
    if (wantTurnur) url += '&includeTurnur=true';
    if (wantWh)     url += '&includeWormholes=true';
    if (wantAnsi)   url += '&includeAnsiblex=true';
    if (wantWh || wantAnsi) url += allScope ? '&whScope=all' : `&mapId=${activeMapId}`;
    api<Record<string, RouteEntry>>(url)
      .then(r => { if (!cancelled) setData(r); })
      .catch(() => { if (!cancelled) setData({}); });
    return () => { cancelled = true; };
  }, [from, targetsKey, routeMode, wantThera, wantTurnur, wantWh, wantAnsi, allScope, activeMapId, flagRevision]);

  return data;
}
