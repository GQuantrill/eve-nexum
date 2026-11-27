import { useEffect, useRef } from 'react';
import { readUserSetting, writeUserSetting } from '../hooks/useUserSetting';

// "Route to here" (the map's right-click menu) puts a system in the Route
// Planner's To field. The planner may be folded, hidden, behind a collapsed
// sidebar or popped out into a window of its own, so this opens it first and
// tells every window: the one showing the planner takes it.
//
// A request made while the planner isn't mounted (it was folded, so its body
// wasn't rendered) is held briefly and taken when it mounts.

export interface RouteTarget { id: number; name: string }

const PANE = 'routePlanner';
const HOLD_MS = 5000;

const listeners = new Set<(t: RouteTarget) => void>();
let pending: { target: RouteTarget; at: number } | null = null;

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('nexum-route-to') : null;
channel?.addEventListener('message', (e: MessageEvent) => {
  const t = e.data as Partial<RouteTarget> | null;
  if (t && Number.isInteger(t.id) && typeof t.name === 'string') deliver({ id: t.id as number, name: t.name });
});

function deliver(t: RouteTarget): void {
  if (listeners.size > 0) { pending = null; listeners.forEach((f) => f(t)); }
  else pending = { target: t, at: Date.now() };
}

/** Put `target` in the Route Planner's To field, opening the planner. */
export function routeTo(target: RouteTarget): void {
  const hidden = readUserSetting<string[]>('nexum.sidebar.hidden', []);
  if (Array.isArray(hidden) && hidden.includes(PANE)) writeUserSetting('nexum.sidebar.hidden', hidden.filter((h) => h !== PANE));
  writeUserSetting(`nexum.panel.collapsed.${PANE}`, false);
  writeUserSetting('nexum.sidebar.collapsed', false);
  deliver(target);
  channel?.postMessage(target);
}

/** For the Route Planner: called with each system sent by "Route to here". */
export function useRouteToRequests(onTarget: (t: RouteTarget) => void): void {
  const cb = useRef(onTarget);
  useEffect(() => { cb.current = onTarget; }, [onTarget]);
  useEffect(() => {
    const f = (t: RouteTarget) => cb.current(t);
    listeners.add(f);
    if (pending && Date.now() - pending.at < HOLD_MS) f(pending.target);
    pending = null;
    return () => { listeners.delete(f); };
  }, []);
}

/** Tests only. */
export function _resetRouteTargetForTests(): void { listeners.clear(); pending = null; }
