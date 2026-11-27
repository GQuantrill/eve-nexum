import { useEffect, useRef } from 'react';
import { readUserSetting, writeUserSetting } from '../hooks/useUserSetting';
import { POPOUT_PANE } from './popout';

// "Route to here" / "Route from here" (the map's right-click menu) put a
// system in the Route Planner's To / From field. The planner may be folded, hidden, behind a collapsed
// sidebar or popped out into a window of its own, so this opens it first and
// tells this window and a popped-out planner window, whichever shows it.
//
// A request made while the planner isn't mounted (it was folded, so its body
// wasn't rendered) is held briefly and taken when it mounts.

export interface RouteTarget { id: number; name: string; end: 'from' | 'to' }

const PANE = 'routePlanner';
const HOLD_MS = 5000;

const listeners = new Set<(t: RouteTarget) => void>();
// One held request per end, so "from" then "to" before the planner mounts keeps both.
let pending: Array<{ target: RouteTarget; at: number }> = [];

// Other windows hear it, but only a popped-out Route Planner takes it: a
// second nexum tab is its own session and keeps its own planner.
const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('nexum-route-to') : null;
channel?.addEventListener('message', (e: MessageEvent) => {
  if (POPOUT_PANE !== PANE) return;
  const t = e.data as Partial<RouteTarget> | null;
  if (t && Number.isInteger(t.id) && typeof t.name === 'string' && (t.end === 'from' || t.end === 'to')) {
    deliver({ id: t.id as number, name: t.name, end: t.end });
  }
});

function deliver(t: RouteTarget): void {
  if (listeners.size > 0) { listeners.forEach((f) => f(t)); return; }
  pending = [...pending.filter((p) => p.target.end !== t.end), { target: t, at: Date.now() }];
}

/** Put `target` in the Route Planner's From or To field, opening the planner. */
export function routeTo(target: RouteTarget): void {
  const hidden = readUserSetting<string[]>('nexum.sidebar.hidden', []);
  if (Array.isArray(hidden) && hidden.includes(PANE)) writeUserSetting('nexum.sidebar.hidden', hidden.filter((h) => h !== PANE));
  writeUserSetting(`nexum.panel.collapsed.${PANE}`, false);
  writeUserSetting('nexum.sidebar.collapsed', false);
  deliver(target);
  channel?.postMessage(target);
}

/** For the Route Planner: called with each system sent from the map menu. */
export function useRouteToRequests(onTarget: (t: RouteTarget) => void): void {
  const cb = useRef(onTarget);
  useEffect(() => { cb.current = onTarget; }, [onTarget]);
  useEffect(() => {
    const f = (t: RouteTarget) => cb.current(t);
    listeners.add(f);
    const now = Date.now();
    for (const p of pending) if (now - p.at < HOLD_MS) f(p.target);
    pending = [];
    return () => { listeners.delete(f); };
  }, []);
}

/** Tests only. */
export function _resetRouteTargetForTests(): void { listeners.clear(); pending = []; }
