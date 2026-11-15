import { describe, it, expect, vi } from 'vitest';

vi.mock('../i18n', () => ({
  default: { t: (k: string, v?: Record<string, unknown>) => (v ? `${k}${JSON.stringify(v)}` : k) },
}));

const apiMock = vi.fn();
vi.mock('./client', () => ({ api: (...a: unknown[]) => apiMock(...a) }));
vi.mock('../utils/toastStore', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
let sendTo = 'me';
vi.mock('../hooks/useUserSetting', () => ({ readUserSetting: () => sendTo }));
let pinned: { charId: number } | null = null;
vi.mock('../store/mapStore', () => ({ useMapStore: { getState: () => ({ routeOrigin: pinned }) } }));

import { describeWaypointResults, setDestination, type WaypointResult } from './waypoint';

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

describe('who a destination goes to', () => {
  const sentTo = async (targets?: number[]) => {
    apiMock.mockReset();
    apiMock.mockResolvedValue({ results: [{ charId: 7, characterId: 1, characterName: 'Alt', status: 'ok' }] });
    await setDestination(30000142, 'Jita', targets);
    return JSON.parse(apiMock.mock.calls[0][1].body).to;
  };

  it("goes to the character this tab is pinned to", async () => {
    sendTo = 'me'; pinned = { charId: 7 };
    expect(await sentTo()).toEqual([7]);
  });

  it("goes to the session's character with no pin", async () => {
    sendTo = 'me'; pinned = null;
    expect(await sentTo()).toBeUndefined();
  });

  it('keeps "all online" and an explicit choice ahead of the pin', async () => {
    sendTo = 'allOnline'; pinned = { charId: 7 };
    expect(await sentTo()).toBe('allOnline');
    sendTo = 'me';
    expect(await sentTo([3, 4])).toEqual([3, 4]);
  });
});
