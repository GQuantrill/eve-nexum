import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useOnlineStatus } from './useOnlineStatus';
import { setPilotOnline, _resetPilotActivityForTests } from './pilotActivity';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ api: apiMock }));

beforeEach(() => { _resetPilotActivityForTests(); apiMock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('useOnlineStatus', () => {
  it('reads the flag from the location poll, not from its own timer', async () => {
    apiMock.mockResolvedValue({ online: false, lastLogin: null });
    const { result } = renderHook(() => useOnlineStatus(true));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));   // the mount read

    act(() => { setPilotOnline(true); });
    await waitFor(() => expect(result.current.online).toBe(true));

    act(() => { setPilotOnline(false); });
    await waitFor(() => expect(result.current.online).toBe(false));
  });

  it('does not poll /online on a clock', async () => {
    vi.useFakeTimers();
    apiMock.mockResolvedValue({ online: true, lastLogin: null });
    renderHook(() => useOnlineStatus(true));
    await act(async () => { vi.advanceTimersByTime(5 * 60 * 1000); });
    // Previously this was every 30s — ten calls in this window.
    expect(apiMock.mock.calls.length).toBeLessThanOrEqual(1);
    vi.useRealTimers();
  });

  it('re-reads lastLogin when the pilot comes back online', async () => {
    apiMock.mockResolvedValue({ online: false, lastLogin: null });
    renderHook(() => useOnlineStatus(true));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));

    apiMock.mockResolvedValue({ online: true, lastLogin: '2026-09-27T10:00:00Z' });
    act(() => { setPilotOnline(true); });
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
  });

  it('stays "unknown" when the scope is missing, rather than claiming offline', async () => {
    // The location poll degrades a revoked/unscoped token to online:false. If
    // that leaked through, the dot would assert the pilot is logged out when we
    // simply have no way to know.
    apiMock.mockResolvedValue({ online: null, scopeMissing: true });
    const { result } = renderHook(() => useOnlineStatus(true));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));

    act(() => { setPilotOnline(false); });
    await waitFor(() => expect(result.current.online).toBeNull());

    act(() => { setPilotOnline(true); });
    await waitFor(() => expect(result.current.online).toBeNull());
  });

  it('makes no request at all when disabled', async () => {
    renderHook(() => useOnlineStatus(false));
    await act(async () => {});
    expect(apiMock).not.toHaveBeenCalled();
  });
});
