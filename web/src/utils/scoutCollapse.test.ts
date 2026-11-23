import { describe, it, expect, vi } from 'vitest';
import { matchScout, collapseScoutFor, restoreScoutFor } from './scoutCollapse';
import type { ScoutConnection } from '../hooks/useScoutConnections';

const THERA = 31000005;
const hole = (id: string, out: number, inn: number, expired = false) =>
  ({ id, outSystemId: out, inSystemId: inn, expired } as ScoutConnection);

describe('EVE Scout hole for a mapped link', () => {
  it('matches the hole joining the same two systems, either way round', () => {
    const scout = [hole('s1', THERA, 30000142), hole('s2', THERA, 31000999)];
    expect(matchScout({ connId: 'c', a: 31000999, b: THERA }, scout)?.id).toBe('s2');
  });

  it('flags nothing when two holes join the same pair, or the hole is already flagged', () => {
    expect(matchScout({ connId: 'c', a: THERA, b: 31000999 },
      [hole('s1', THERA, 31000999), hole('s2', THERA, 31000999)])).toBeNull();
    expect(matchScout({ connId: 'c', a: THERA, b: 31000999 }, [hole('s1', THERA, 31000999, true)])).toBeNull();
  });

  it('flags on the way out and clears its own flag on undo', async () => {
    const setExpired = vi.fn(async () => {});
    const list = async () => [hole('s1', THERA, 31000999)];
    await collapseScoutFor([{ connId: 'x', a: THERA, b: 31000999 }], { list, setExpired });
    expect(setExpired).toHaveBeenCalledWith('s1', true);
    await restoreScoutFor(['x'], { setExpired });
    expect(setExpired).toHaveBeenLastCalledWith('s1', false);
    setExpired.mockClear();
    await restoreScoutFor(['x'], { setExpired });
    expect(setExpired).not.toHaveBeenCalled();
  });
});
