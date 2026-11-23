// A Thera or Turnur hole the pilot has mapped is often on EVE Scout's list too,
// and routes take both. Rolling or deleting the mapped one left EVE Scout's
// copy in the graph, so the route (and the proximity banner) still went
// through a hole that was gone: "2 jumps from an incursion" via a Thera
// connection the pilot had just rolled. When a mapped link goes (cut, rolled,
// deleted, or its system deleted), the matching EVE Scout hole is flagged
// collapsed, the same flag as the Thera panel's button; undo or un-breaking
// the link clears it again.
//
// Matched by its two systems. Two EVE Scout holes between the same pair can't
// be told apart from here, so neither is flagged.

import type { ScoutConnection } from '../hooks/useScoutConnections';

export interface GoneLink {
  connId: string;
  a: number | null;
  b: number | null;
}

/** The one live EVE Scout hole joining the link's two systems, if exactly one. */
export function matchScout(link: GoneLink, scout: ScoutConnection[]): ScoutConnection | null {
  if (!link.a || !link.b || link.a === link.b) return null;
  const hits = scout.filter((c) =>
    (c.outSystemId === link.a && c.inSystemId === link.b)
    || (c.outSystemId === link.b && c.inSystemId === link.a));
  if (hits.length !== 1 || hits[0].expired) return null;
  return hits[0];
}

interface Deps {
  list: () => Promise<ScoutConnection[]>;
  setExpired: (id: string, expired: boolean) => Promise<void>;
}

// Map link id -> the EVE Scout hole flagged because of it, so undo clears only
// what this did, never a flag someone set by hand.
const flagged = new Map<string, string>();

export async function collapseScoutFor(links: GoneLink[], deps: Deps): Promise<void> {
  const useful = links.filter((l) => l.a && l.b && !flagged.has(l.connId));
  if (!useful.length) return;
  const scout = await deps.list();
  if (!scout.length) return;
  for (const link of useful) {
    const hit = matchScout(link, scout);
    if (!hit) continue;
    flagged.set(link.connId, hit.id);
    await deps.setExpired(hit.id, true).catch(() => { flagged.delete(link.connId); });
  }
}

export async function restoreScoutFor(connIds: string[], deps: Pick<Deps, 'setExpired'>): Promise<void> {
  for (const id of connIds) {
    const scoutId = flagged.get(id);
    if (!scoutId) continue;
    flagged.delete(id);
    await deps.setExpired(scoutId, false).catch(() => { /* stays flagged; the Thera panel can clear it */ });
  }
}
