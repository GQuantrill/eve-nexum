import { describe, it, expect, beforeEach, vi } from 'vitest';

const api = vi.hoisted(() => vi.fn());
const enqueue = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ api, apiUrl: (p: string) => p }));
vi.mock('./pendingQueue', async (importActual) => {
  const actual = await importActual<typeof import('./pendingQueue')>();
  return { ...actual, enqueue, flushQueue: vi.fn() };
});

import { useMapStore } from './mapStore';
import { isPermanentRejection } from './pendingQueue';

class ApiErr extends Error {
  status: number;
  constructor(status: number) { super(`API ${status}`); this.status = status; }
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('isPermanentRejection', () => {
  // A 4xx is the server's decision and will be repeated; anything else is a
  // delivery problem the queue exists to ride out.
  it.each([400, 403, 404, 409, 422])('treats %i as permanent', (s) => {
    expect(isPermanentRejection(new ApiErr(s))).toBe(true);
  });

  // 401 is excluded on purpose: the write should survive a re-login.
  it.each([401, 408, 429, 500, 502, 503])('treats %i as retryable', (s) => {
    expect(isPermanentRejection(new ApiErr(s))).toBe(false);
  });

  it('retries anything with no status at all (offline, aborted)', () => {
    expect(isPermanentRejection(new Error('Failed to fetch'))).toBe(false);
    expect(isPermanentRejection(null)).toBe(false);
    expect(isPermanentRejection(undefined)).toBe(false);
  });
});

// The reported bug: jumping a connection sometimes left a second copy of the
// system on the map that had to be deleted by hand. A system already present is
// refused by uq_map_systems_eve_system, and the optimistic node used to stay put
// — a node that existed in one tab and nowhere else.
describe('optimistic adds the server refuses', () => {
  beforeEach(() => {
    api.mockReset(); enqueue.mockReset();
    useMapStore.setState({
      activeMapId: 'map-1',
      map: { id: 'map-1', name: 'M', systems: [], connections: [], routes: [] } as never,
    } as never);
  });

  it('drops the node when the server rejects it, and does not queue a retry', async () => {
    api.mockRejectedValue(new ApiErr(409));
    const id = useMapStore.getState().addSystem('J123456', 'C3', { x: 0, y: 0 }, { eveSystemId: 31000001 });
    expect(useMapStore.getState().map.systems.map((s) => s.id)).toContain(id);

    await settle();
    expect(useMapStore.getState().map.systems.map((s) => s.id)).not.toContain(id);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('keeps the node and queues it when the failure is only a delivery problem', async () => {
    api.mockRejectedValue(new Error('Failed to fetch'));
    const id = useMapStore.getState().addSystem('J123456', 'C3', { x: 0, y: 0 }, { eveSystemId: 31000001 });

    await settle();
    expect(useMapStore.getState().map.systems.map((s) => s.id)).toContain(id);
    expect(enqueue).toHaveBeenCalled();
  });

  it('leaves the node alone when the write succeeds', async () => {
    api.mockResolvedValue({ system: { eveSystemId: 31000001, security: -1 } });
    const id = useMapStore.getState().addSystem('J123456', 'C3', { x: 0, y: 0 }, { eveSystemId: 31000001 });

    await settle();
    expect(useMapStore.getState().map.systems.map((s) => s.id)).toContain(id);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
