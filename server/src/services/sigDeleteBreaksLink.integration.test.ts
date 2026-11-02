import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { deleteSignature } from './mapWrite.js';

const dbReady = await ensureIntegrationDb();

// Deleting a wormhole sig quarantines the link it was holding, on the server,
// whichever system the deleting pilot's sig pane happens to be showing.

let user: number, mapId: string, home: string, far: string;
const actor = () => ({ userId: user, clientId: null });

async function seedSystem(name: string, cls: string): Promise<string> {
  const id = randomUUID();
  await db.query(`INSERT INTO map_systems (id, map_id, name, system_class) VALUES ($1, $2, $3, $4)`, [id, mapId, name, cls]);
  return id;
}
let seq = 0;
async function seedSig(systemId: string, whType: string, whLeadsTo: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO map_signatures (system_id, sig_id, sig_type, wh_type, wh_leads_to)
     VALUES ($1, $2, 'wormhole', $3, $4) RETURNING id`,
    [systemId, `ABC-${100 + ++seq}`, whType, whLeadsTo]);
  return rows[0].id;
}
async function seedLink(opts: { type?: string | null; sourceSig?: string | null } = {}): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO map_connections (id, map_id, source_id, target_id, connection_type, wh_type, source_signature_id)
     VALUES ($1, $2, $3, $4, 'standard', $5, $6)`,
    [id, mapId, home, far, opts.type ?? null, opts.sourceSig ?? null]);
  return id;
}
const link = async (id: string) =>
  (await db.query<{ broken: boolean; brokenAt: Date | null }>(
    `SELECT broken, broken_at AS "brokenAt" FROM map_connections WHERE id = $1`, [id])).rows[0];

describe.skipIf(!dbReady)('deleting a sig breaks the link it held (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    user = await seedUser({ characterId: 202, role: 'admin' });
    const { rows } = await db.query<{ id: string }>(`INSERT INTO maps (user_id, name) VALUES ($1, 'm') RETURNING id`, [user]);
    mapId = rows[0].id;
    home = await seedSystem('J100001', 'C5');
    far = await seedSystem('J200002', 'C5');
  });

  it('breaks an untyped link whose sig a jump pinned to the system by name', async () => {
    const sig = await seedSig(home, '', 'J200002');
    const c = await seedLink();
    await deleteSignature(mapId, home, sig, actor());
    const after = await link(c);
    expect(after.broken).toBe(true);
    expect(after.brokenAt).not.toBeNull(); // the broken-link cleanup measures from this
  });

  it('breaks a link that lists the sig as its backing signature', async () => {
    const sig = await seedSig(home, 'H296', 'C5');
    const c = await seedLink({ type: 'H296', sourceSig: sig });
    await deleteSignature(mapId, home, sig, actor());
    expect((await link(c)).broken).toBe(true);
  });

  it('breaks a link labelled with the sig type when nothing else points there', async () => {
    const sig = await seedSig(home, 'H296', 'C5');
    const c = await seedLink({ type: 'H296' });
    await deleteSignature(mapId, home, sig, actor());
    expect((await link(c)).broken).toBe(true);
  });

  it('keeps a pinned link alive when another sig is pinned to the same system', async () => {
    const sig = await seedSig(home, '', 'J200002');
    await seedSig(home, 'K162', 'J200002');
    const c = await seedLink();
    await deleteSignature(mapId, home, sig, actor());
    expect((await link(c)).broken).toBe(false);
  });

  it('keeps a typed link alive while another sig still leads to that class', async () => {
    const sig = await seedSig(home, 'H296', 'C5');
    await seedSig(home, 'H296', 'C5'); // the respawned static
    const c = await seedLink({ type: 'H296' });
    await deleteSignature(mapId, home, sig, actor());
    expect((await link(c)).broken).toBe(false);
  });

  it('leaves alone a link the sig had no tie to', async () => {
    const sig = await seedSig(home, 'D382', 'C2'); // a hole to somewhere else
    const c = await seedLink({ type: 'H296' });
    await deleteSignature(mapId, home, sig, actor());
    expect((await link(c)).broken).toBe(false);
  });

  it('does nothing when the sig is not in this map', async () => {
    const sig = await seedSig(home, '', 'J200002');
    const c = await seedLink();
    await deleteSignature(randomUUID(), home, sig, actor());
    expect((await link(c)).broken).toBe(false);
  });
});
