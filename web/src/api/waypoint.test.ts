import { describe, it, expect, vi } from 'vitest';

vi.mock('../i18n', () => ({
  default: { t: (k: string, v?: Record<string, unknown>) => (v ? `${k}${JSON.stringify(v)}` : k) },
}));

import { describeWaypointResults, type WaypointResult } from './waypoint';

const r = (characterName: string, status: WaypointResult['status']): WaypointResult =>
  ({ charId: 1, characterId: 1, characterName, status });

describe('describeWaypointResults', () => {
  it('counts who got it and says nothing else when all did', () => {
    const d = describeWaypointResults([r('A', 'ok'), r('B', 'ok')], true, 'Jita');
    expect(d).toEqual({ ok: 2, success: 'routeToast.destinationSetFor{"system":"Jita","count":2}', problems: null });
  });

  it('names the characters it missed and why', () => {
    const d = describeWaypointResults([r('A', 'ok'), r('B', 'offline'), r('C', 'no_scope')], false, 'Jita');
    expect(d.ok).toBe(1);
    expect(d.success).toContain('routeToast.waypointAddedFor');
    expect(d.problems).toBe('routeToast.notSentTo{"list":"B (routeToast.reason.offline), C (routeToast.reason.no_scope)"}');
  });

  it('reports a total failure differently', () => {
    const d = describeWaypointResults([r('A', 'esi_error')], true, 'Jita');
    expect(d.ok).toBe(0);
    expect(d.success).toBeNull();
    expect(d.problems).toContain('routeToast.noneSent');
  });
});
