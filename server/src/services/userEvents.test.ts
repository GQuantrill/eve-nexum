import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import { subscribeUser, publishToUsers } from './userEvents.js';

const fakeRes = () => {
  const frames: string[] = [];
  return { frames, res: { write: (f: string) => { frames.push(f); return true; } } as unknown as Response };
};

describe('user events', () => {
  it('reaches only the addressed characters, on every open stream', () => {
    const a1 = fakeRes(), a2 = fakeRes(), b = fakeRes();
    subscribeUser(1, a1.res); subscribeUser(1, a2.res); subscribeUser(2, b.res);
    publishToUsers([1], { type: 'settings.changed', entries: { k: 1 } });
    expect(a1.frames).toHaveLength(1);
    expect(a2.frames).toHaveLength(1);
    expect(b.frames).toHaveLength(0);
    expect(JSON.parse(a1.frames[0].slice(6))).toEqual({ type: 'settings.changed', entries: { k: 1 } });
  });

  it('stops after unsubscribing', () => {
    const r = fakeRes();
    const off = subscribeUser(3, r.res);
    off();
    publishToUsers([3], { type: 'x' });
    expect(r.frames).toHaveLength(0);
  });
});
