import { describe, it, expect, vi, beforeAll } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSovData } from './useSovData';

const NULLSEC = 30004759; // held by alliance 1354830081
const JSPACE  = 31000123; // no sov entry -- J-space never has one

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body =
      url.includes('/sovereignty/map/') ? [{ system_id: NULLSEC, alliance_id: 1354830081 }] :
      url.includes('/universe/factions/') ? [] :
      url.includes('/alliances/') ? { name: 'Goonswarm Federation', ticker: 'CONDI' } :
      null;
    return { ok: true, json: async () => body } as Response;
  }));
});

describe('useSovData', () => {
  it('drops the previous system\'s sov when moving to a system with none', async () => {
    const { result, rerender } = renderHook(({ id }) => useSovData(id), { initialProps: { id: NULLSEC } });
    await waitFor(() => expect(result.current?.controller).toBe('Goonswarm Federation'));

    rerender({ id: JSPACE });
    expect(result.current).toBeNull();
    // ...and stays null once the lookup for the J-space system has finished.
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBeNull();

    rerender({ id: NULLSEC });
    await waitFor(() => expect(result.current?.controller).toBe('Goonswarm Federation'));
  });
});
