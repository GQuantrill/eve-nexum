import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const settings: Record<string, unknown> = {};
vi.mock('../hooks/useUserSetting', () => ({
  readUserSetting: (k: string, d: unknown) => (k in settings ? settings[k] : d),
  writeUserSetting: (k: string, v: unknown) => { settings[k] = v; },
}));

const { routeTo, useRouteToRequests, _resetRouteTargetForTests } = await import('./routePlannerTarget');

beforeEach(() => {
  _resetRouteTargetForTests();
  for (const k of Object.keys(settings)) delete settings[k];
});

describe('routeTo', () => {
  it('hands the system to a mounted planner and opens it', () => {
    settings['nexum.sidebar.hidden'] = ['routePlanner', 'a0'];
    settings['nexum.panel.collapsed.routePlanner'] = true;
    const got: unknown[] = [];
    renderHook(() => useRouteToRequests((t) => got.push(t)));
    routeTo({ id: 30000142, name: 'Jita' });
    expect(got).toEqual([{ id: 30000142, name: 'Jita' }]);
    expect(settings['nexum.sidebar.hidden']).toEqual(['a0']);
    expect(settings['nexum.panel.collapsed.routePlanner']).toBe(false);
    expect(settings['nexum.sidebar.collapsed']).toBe(false);
  });

  it('holds it for a planner that mounts just after (it was folded)', () => {
    routeTo({ id: 30002187, name: 'Amarr' });
    const got: unknown[] = [];
    renderHook(() => useRouteToRequests((t) => got.push(t)));
    expect(got).toEqual([{ id: 30002187, name: 'Amarr' }]);
    // Taken once: a later mount doesn't get it again.
    const again: unknown[] = [];
    renderHook(() => useRouteToRequests((t) => again.push(t)));
    expect(again).toEqual([]);
  });
});
