import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// ESI knows two pilots; every call is counted.
const calls = vi.hoisted(() => [] as string[][]);
vi.mock('../utils/esi.js', () => ({
  esiFetch: vi.fn(async (_url: string, init: RequestInit = {}) => {
    const names = JSON.parse(String(init.body)) as string[];
    calls.push(names);
    const pilots = [{ id: 91, name: 'Jord4n Echo' }, { id: 92, name: 'Coreola' }]
      .filter((p) => names.some((n) => n.toLowerCase() === p.name.toLowerCase()));
    return pilots.length
      ? new Response(JSON.stringify({ characters: pilots }), { status: 200 })
      : new Response(null, { status: 404 });
  }),
}));

import searchRouter from './search.js';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { session: Record<string, unknown> }).session = { userId: 1, characterId: 1 };
  next();
});
app.use('/api/search', searchRouter);

const batch = (names: unknown) => request(app).post('/api/search/characters/batch').send({ names });

describe('POST /api/search/characters/batch', () => {
  it('keeps only the names that are pilots, asking ESI once per name', async () => {
    const res = await batch(['Jord4n Echo', 'Jord4n', 'Coreola', 'nv']);
    expect(res.status).toBe(200);
    expect(res.body.map((p: { name: string }) => p.name).sort()).toEqual(['Coreola', 'Jord4n Echo']);
    expect(calls).toHaveLength(1);
    // Cached, hits and misses alike: no second call.
    expect((await batch(['jord4n echo', 'Jord4n'])).body).toEqual([{ id: 91, name: 'Jord4n Echo' }]);
    expect(calls).toHaveLength(1);
  });

  it('refuses too many names or a non-list', async () => {
    expect((await batch(Array.from({ length: 31 }, (_, i) => `Pilot ${i}`))).status).toBe(400);
    expect((await batch('Coreola')).status).toBe(400);
  });
});
