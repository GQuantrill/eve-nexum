import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { createSignature, updateSignature } from './mapWrite.js';

const dbReady = await ensureIntegrationDb();

// A sig pasted as unknown and typed afterwards counts in the scan stats under
// its type, not as unknown -- once, for the pilot who scanned it.

let scout: number, other: number, mapId: string, sys: string;

const input = (sigId: string, sigType: string) => ({
  sigId, sigType, name: '', notes: '', whType: '', whLeadsTo: '', ghostType: '', massStatus: '', timeStatus: '',
});
// The stats writes don't hold up the sig write, so wait for them to land.
async function events(): Promise<{ userId: number; sigType: string | null }[]> {
  let rows: { userId: number; sigType: string | null }[] = [];
  for (let i = 0; i < 20; i++) {
    ({ rows } = await db.query(
      `SELECT user_id AS "userId", sig_type AS "sigType" FROM user_events WHERE event_type = 'signature' ORDER BY id`));
    if (rows.length && rows.every((r) => r.sigType !== 'unknown')) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return rows;
}

describe.skipIf(!dbReady)('scan stats take a sig type set after the paste (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    scout = await seedUser({ characterId: 301, role: 'admin' });
    other = await seedUser({ characterId: 302, role: 'admin' });
    const { rows } = await db.query<{ id: string }>(`INSERT INTO maps (user_id, name) VALUES ($1, 'm') RETURNING id`, [scout]);
    mapId = rows[0].id;
    sys = randomUUID();
    await db.query(`INSERT INTO map_systems (id, map_id, name, system_class) VALUES ($1, $2, 'J100001', 'C5')`, [sys, mapId]);
  });

  it('typing an unknown sig by hand gives its event the type', async () => {
    const { row } = await createSignature(mapId, sys, input('ABC-123', 'unknown'), { userId: scout, clientId: null });
    await updateSignature(mapId, sys, row.id, { sigType: 'relic' }, { userId: other, clientId: null });
    expect(await events()).toEqual([{ userId: scout, sigType: 'relic' }]);
  });

  it('a later paste that fills the type in does the same, without counting it twice', async () => {
    await createSignature(mapId, sys, input('ABC-123', 'unknown'), { userId: scout, clientId: null });
    await createSignature(mapId, sys, input('ABC-123', 'data'), { userId: other, clientId: null });
    expect(await events()).toEqual([{ userId: scout, sigType: 'data' }]);
  });

  it('leaves an event that already had a type alone', async () => {
    const { row } = await createSignature(mapId, sys, input('ABC-123', 'gas'), { userId: scout, clientId: null });
    await updateSignature(mapId, sys, row.id, { sigType: 'relic' }, { userId: scout, clientId: null });
    await new Promise((r) => setTimeout(r, 100));
    expect(await events()).toEqual([{ userId: scout, sigType: 'gas' }]);
  });
});
