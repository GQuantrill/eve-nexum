import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { buildRouteOverlay } from './routeOverlay.js';
import { edgeKey } from './routeGraph.js';

const dbReady = await ensureIntegrationDb();

describe.skipIf(!dbReady)('route overlay: mapped holes (integration)', () => {
  let mapId: string;
  beforeEach(async () => {
    await truncateAll();
    const me = await seedUser({ characterId: 900, role: 'full' });
    ({ rows: [{ id: mapId }] } = await db.query<{ id: string }>(
      `INSERT INTO maps (user_id, name) VALUES ($1, 'M') RETURNING id`, [me]));
  });

  const system = async (eveId: number, name: string, cls: string) => (await db.query<{ id: string }>(
    `INSERT INTO map_systems (id, map_id, eve_system_id, name, system_class) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [crypto.randomUUID(), mapId, eveId, name, cls])).rows[0].id;
  const sig = async (systemId: string, sigId: string) => (await db.query<{ id: string }>(
    `INSERT INTO map_signatures (system_id, sig_id, sig_type) VALUES ($1, $2, 'wormhole') RETURNING id`,
    [systemId, sigId])).rows[0].id;

  it('carries each direction the signature in the system it leaves', async () => {
    const j = await system(31000001, 'J100001', 'C3');
    const k = await system(30003069, 'Sosa', 'LS');
    const n = await system(30000142, 'Jita', 'HS');
    await db.query(
      `INSERT INTO map_connections (id, map_id, source_id, target_id, source_signature_id, target_signature_id)
       VALUES ($7, $1, $2, $3, $4, $5), ($8, $1, $3, $6, NULL, NULL)`,
      [mapId, j, k, await sig(j, 'ABC-123'), await sig(k, 'XYZ-789'), n, crypto.randomUUID(), crypto.randomUUID()]);
    const o = await buildRouteOverlay({ thera: false, turnur: false, wormholes: true, ansiblex: false, mapIds: [mapId] });
    expect(o?.edgeMeta.get(edgeKey(31000001, 30003069))?.sig).toBe('ABC-123');
    expect(o?.edgeMeta.get(edgeKey(30003069, 31000001))?.sig).toBe('XYZ-789');
    // No signature linked: no sig, the hop still routes.
    expect(o?.edgeMeta.get(edgeKey(30003069, 30000142))).toMatchObject({ kind: 'wormhole' });
    expect(o?.edgeMeta.get(edgeKey(30003069, 30000142))?.sig).toBeUndefined();
  });
});
