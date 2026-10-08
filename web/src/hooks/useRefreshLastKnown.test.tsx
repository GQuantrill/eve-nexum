import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({
  online: false,
  user: { id: 1 } as unknown,
  refresh: vi.fn(),
}));

vi.mock('./useCharacterLocation', () => ({
  useCharacterLocation: () => ({ online: state.online, system: null, ship: null }),
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: state.user, refresh: state.refresh }),
}));

import { useRefreshLastKnown } from './useRefreshLastKnown';

describe('useRefreshLastKnown', () => {
  beforeEach(() => {
    state.refresh = vi.fn();
    state.user = { id: 1 };
    state.online = false;
  });

  it('re-reads the account when the pilot goes offline', () => {
    state.online = true;
    const { rerender } = renderHook(() => useRefreshLastKnown());
    expect(state.refresh).not.toHaveBeenCalled();   // still flying

    state.online = false;
    rerender();
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it('does nothing on a tab opened while already logged out', () => {
    // The cached value is whatever /auth/me just returned, so it is current.
    renderHook(() => useRefreshLastKnown());
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it('fires once per logoff, not repeatedly while offline', () => {
    state.online = true;
    const { rerender } = renderHook(() => useRefreshLastKnown());
    state.online = false;
    rerender();
    rerender();
    rerender();
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it('fires again on a second logoff in the same session', () => {
    state.online = true;
    const { rerender } = renderHook(() => useRefreshLastKnown());
    state.online = false; rerender();
    state.online = true;  rerender();
    state.online = false; rerender();
    expect(state.refresh).toHaveBeenCalledTimes(2);
  });

  it('stays quiet with no signed-in user', () => {
    state.user = null;
    state.online = true;
    const { rerender } = renderHook(() => useRefreshLastKnown());
    state.online = false;
    rerender();
    expect(state.refresh).not.toHaveBeenCalled();
  });
});
