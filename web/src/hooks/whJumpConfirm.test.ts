import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Signature } from '../types';

const settings: Record<string, unknown> = {};
const sigs: Signature[] = [];
const toastShow = vi.fn();
const copy = vi.fn<(text: string) => Promise<boolean>>(async () => true);

vi.mock('../api/client', () => ({
  api: vi.fn(async (_url: string, init?: { method?: string }) => (init?.method ? {} : sigs)),
}));
vi.mock('../utils/toastStore', () => ({ toast: { show: (...a: unknown[]) => toastShow(...a), success: vi.fn(), error: vi.fn() } }));
vi.mock('../utils/whAutoDetect', () => ({ reevaluateConnectionsForSystem: vi.fn() }));
vi.mock('../utils/copyWhenFocused', () => ({ copyWhenFocused: (t: string) => copy(t) }));
vi.mock('./useUserSetting', () => ({
  readUserSetting: (k: string, d: unknown) => (k in settings ? settings[k] : d),
}));
vi.mock('./useWormholeTypes', () => ({
  wormholeTypesSnapshot: () => ({ D382: { totalMass: 2e9, maxJumpMass: 375e6, massRegen: 0, lifetimeHours: 16, dest: 'C2', src: [] } }),
}));
vi.mock('../store/mapStore', () => ({
  awaitConnectionType: () => null,
  useMapStore: { getState: () => ({ map: {
    bookmarkFormat: null, connections: [],
    systems: [{ name: 'J100001', systemClass: 'C2', alias: 'Home' }],
  } }) },
}));

const { maybeConfirmWhJump } = await import('./whJumpConfirm');

const ctx = { mapId: 'm', fromMapSystemId: 's', toEveSystemId: 31000001, toClass: 'C2', toName: 'J100001', connId: null };
const hole = (over: Partial<Signature>): Signature =>
  ({ id: over.sigId ?? 'x', sigId: 'ABC-123', sigType: 'wormhole', name: '', notes: '', whType: 'D382', whLeadsTo: '', ...over } as Signature);

describe('copy the bookmark name after a jump', () => {
  beforeEach(() => {
    for (const k of Object.keys(settings)) delete settings[k];
    sigs.length = 0;
    toastShow.mockReset();
    copy.mockClear();
  });

  it('copies the jumped hole, now that it leads somewhere, when only one hole fits', async () => {
    settings['nexum.sig.bookmarkFormat'] = '{sig} {leads_to} {dest_type} {size}';
    sigs.push(hole({}));
    await maybeConfirmWhJump(ctx);
    expect(copy).toHaveBeenCalledWith('ABC-123 Home C2 L');
  });

  it('copies the hole the pilot picks when several fit', async () => {
    sigs.push(hole({ sigId: 'ABC-123' }), hole({ sigId: 'XYZ-789' }));
    await maybeConfirmWhJump(ctx);
    expect(copy).not.toHaveBeenCalled();
    const actions = toastShow.mock.calls[0][1].actions as Array<{ label: string; onClick: () => void }>;
    actions.find((a) => a.label === 'XYZ-789')!.onClick();
    expect(copy).toHaveBeenCalledWith('XYZ-789 C2 L');
  });

  it('copies a jumped K162 with the K162 format when the pilot has one', async () => {
    settings['nexum.sig.bookmarkFormat'] = '{sig} {dest_type}';
    settings['nexum.sig.k162BookmarkFormat'] = 'OUT {sig_letters} {leads_to}';
    sigs.push(hole({ whType: 'K162' }));
    await maybeConfirmWhJump(ctx);
    expect(copy).toHaveBeenCalledWith('OUT ABC Home');
  });

  it('copies nothing when the pilot has turned it off', async () => {
    settings['nexum.sig.copyBookmarkOnJump'] = false;
    sigs.push(hole({}));
    await maybeConfirmWhJump(ctx);
    expect(copy).not.toHaveBeenCalled();
  });
});

describe('a hole jumped before it was scanned', () => {
  beforeEach(() => {
    sigs.length = 0;
    toastShow.mockReset();
  });
  const unknown = (sigId: string): Signature =>
    ({ id: sigId, sigId, sigType: 'unknown', name: '', notes: '', whType: '', whLeadsTo: '' } as Signature);

  it('asks which unscanned sig it was, and never picks one itself', async () => {
    const { api } = await import('../api/client');
    sigs.push(unknown('AAA-111'));
    await maybeConfirmWhJump(ctx);
    const actions = toastShow.mock.calls[0][1].actions as Array<{ label: string; onClick: () => void }>;
    expect(actions.map((a) => a.label)).toContain('AAA-111');
    expect(vi.mocked(api).mock.calls.some(([, init]) => (init as { method?: string } | undefined)?.method === 'PATCH')).toBe(false);
    actions.find((a) => a.label === 'AAA-111')!.onClick();
    const patch = vi.mocked(api).mock.calls.find(([, init]) => (init as { method?: string } | undefined)?.method === 'PATCH');
    expect(JSON.parse((patch![1] as { body: string }).body)).toEqual({ whLeadsTo: 'J100001', sigType: 'wormhole' });
  });

  it('does not ask about unscanned sigs when a scanned hole fits', async () => {
    sigs.push(hole({}), unknown('AAA-111'));
    await maybeConfirmWhJump(ctx);
    const opts = toastShow.mock.calls[0][1] as { actions?: Array<{ label: string }> };
    expect((opts.actions ?? []).map((a) => a.label)).not.toContain('AAA-111');
  });
});
