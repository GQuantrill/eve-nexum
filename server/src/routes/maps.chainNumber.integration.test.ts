import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { mapsRouter } from './maps.js';

const dbReady = await ensureIntegrationDb();

function makeApp(userId: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session =
      { userId, characterId: 900, role: 'full', userCorpId: null, userAllianceId: null };
    next();
  });
  app.use('/api/maps', mapsRouter);
  return app;
}

describe.skipIf(!dbReady)('chain numbers (integration)', () => {
  let me: number;
  let app: express.Express;
  let mapId: string;
  let n = 0;

  const system = async (isHome = false): Promise<string> => {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO map_systems (id, map_id, eve_system_id, name, system_class, is_home) VALUES ($1, $2, $3, $4, 'C3', $5)`,
      [id, mapId, 31000200 + ++n, `J${n}`, isHome]);
    return id;
  };
  const link = (a: string, b: string) => db.query(
    `INSERT INTO map_connections (id, map_id, source_id, target_id) VALUES ($1, $2, $3, $4)`,
    [crypto.randomUUID(), mapId, a, b]);
  const jump = (from: string, to: string) =>
    request(app).post(`/api/maps/${mapId}/systems/${to}/chain-number`).send({ fromSystemId: from });

  beforeEach(async () => {
    await truncateAll();
    me = await seedUser({ characterId: 900, role: 'full' });
    app = makeApp(me);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO maps (user_id, name, chain_numbering) VALUES ($1, 'M', TRUE) RETURNING id`, [me]);
    mapId = rows[0].id;
  });

  it('numbers holes in the order they are first jumped, lowest free number first', async () => {
    const home = await system(true);
    const a = await system(), b = await system(), c = await system();
    for (const s of [a, b, c]) await link(home, s);
    const aa = await system(); await link(a, aa);

    expect((await jump(home, a)).body.chainLabel).toBe('1');
    expect((await jump(home, b)).body.chainLabel).toBe('2');
    expect((await jump(a, aa)).body.chainLabel).toBe('11');
    // Jumping back and forth changes nothing; the way home gets no number.
    expect((await jump(home, a)).body.chainLabel).toBe('1');
    expect((await jump(a, home)).body.chainLabel).toBeNull();

    // 2 is gone: the next hole out of home is 2 again.
    await db.query(`DELETE FROM map_systems WHERE id = $1`, [b]);
    expect((await jump(home, c)).body.chainLabel).toBe('2');
    // 1 is gone, 11 left behind: 1 is free again, and a hole out of the
    // new 1 skips the 11 still on the map.
    await db.query(`DELETE FROM map_systems WHERE id = $1`, [a]);
    const d = await system(); await link(home, d);
    expect((await jump(home, d)).body.chainLabel).toBe('1');
    const dd = await system(); await link(d, dd);
    expect((await jump(d, dd)).body.chainLabel).toBe('12');
  });

  it('does nothing when the map does not number chains, or the systems are not linked', async () => {
    const home = await system(true);
    const a = await system(), b = await system();
    await link(home, a);
    expect((await jump(home, b)).status).toBe(400);
    await db.query(`UPDATE maps SET chain_numbering = FALSE WHERE id = $1`, [mapId]);
    expect((await jump(home, a)).body.chainLabel).toBeNull();
  });

  it('can be set by hand, and only to a well-formed number', async () => {
    const a = await system();
    expect((await request(app).patch(`/api/maps/${mapId}/systems/${a}`).send({ chainLabel: '5.10' })).status).toBe(200);
    expect((await request(app).patch(`/api/maps/${mapId}/systems/${a}`).send({ chainLabel: '=cmd' })).status).toBe(400);
    const { rows } = await db.query<{ l: string }>(`SELECT chain_label AS l FROM map_systems WHERE id = $1`, [a]);
    expect(rows[0].l).toBe('5.10');
  });

  // ── Reserving numbers before the jump ──────────────────────────────────
  let sn = 0;
  const sig = async (systemId: string, leadsTo = '', type = 'wormhole'): Promise<string> => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO map_signatures (system_id, sig_id, sig_type, wh_leads_to) VALUES ($1, $2, $3, $4) RETURNING id`,
      [systemId, `ABC-${100 + ++sn}`, type, leadsTo]);
    return rows[0].id;
  };
  const reserve = (systemId: string, sigIds: string[]) =>
    request(app).post(`/api/maps/${mapId}/systems/${systemId}/chain-numbers`).send({ sigIds });
  const sigLabel = async (id: string) =>
    (await db.query<{ l: string | null }>(`SELECT chain_label AS l FROM map_signatures WHERE id = $1`, [id])).rows[0].l;
  const sysLabel = async (id: string) =>
    (await db.query<{ l: string | null }>(`SELECT chain_label AS l FROM map_systems WHERE id = $1`, [id])).rows[0].l;
  const nameOf = async (id: string) =>
    (await db.query<{ n: string }>(`SELECT name AS n FROM map_systems WHERE id = $1`, [id])).rows[0].n;
  const leadTo = async (sigId: string, systemId: string, to: string) =>
    request(app).patch(`/api/maps/${mapId}/systems/${systemId}/signatures/${sigId}`).send({ whLeadsTo: await nameOf(to) });

  it('reserves numbers in click order, and a second click keeps the number', async () => {
    const home = await system(true);
    const x = await sig(home), y = await sig(home), z = await sig(home);
    expect((await reserve(home, [z])).body.reserved).toEqual([{ id: z, chainLabel: '1' }]);
    expect((await reserve(home, [x])).body.reserved).toEqual([{ id: x, chainLabel: '2' }]);
    expect((await reserve(home, [x])).body.reserved).toEqual([{ id: x, chainLabel: '2' }]);
    expect((await reserve(home, [y, x])).body.reserved).toEqual([{ id: y, chainLabel: '3' }, { id: x, chainLabel: '2' }]);
    const r = await request(app).get(`/api/maps/${mapId}/systems/${home}/signatures`);
    expect(r.body.find((s: { id: string }) => s.id === z).chainLabel).toBe('1');
  });

  it('gives two scouts reserving at once different numbers', async () => {
    const home = await system(true);
    const ids = await Promise.all([1, 2, 3, 4, 5, 6].map(() => sig(home)));
    const res = await Promise.all(ids.map((id) => reserve(home, [id])));
    const labels = res.map((r) => r.body.reserved[0].chainLabel).sort();
    expect(labels).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('skips what cannot take a number', async () => {
    const home = await system(true);
    const a = await system(), loose = await system();
    await link(home, a);
    expect((await jump(home, a)).body.chainLabel).toBe('1');
    const data = await sig(home, '', 'data');
    const toNumbered = await sig(home, await nameOf(a));
    expect((await reserve(home, [data, toNumbered])).body.reserved).toEqual([]);
    // A system that isn't home or numbered has nothing to number from.
    expect((await reserve(loose, [await sig(loose)])).body.reserved).toEqual([]);
    // Another system's signature is ignored.
    const other = await sig(a);
    expect((await reserve(home, [other])).body.reserved).toEqual([]);
    // The map not numbering chains: nothing.
    const h2 = await sig(home);
    await db.query(`UPDATE maps SET chain_numbering = FALSE WHERE id = $1`, [mapId]);
    expect((await reserve(home, [h2])).body.reserved).toEqual([]);
  });

  it('a jump through a reserved hole takes its number, out of order', async () => {
    const home = await system(true);
    const a = await system(), b = await system(), c = await system();
    for (const s of [a, b, c]) await link(home, s);
    const sa = await sig(home), sb = await sig(home), sc = await sig(home);
    await reserve(home, [sa, sb, sc]); // 1, 2, 3
    // Jump hole 3 first. Which sig it was isn't known yet: deferred.
    const first = await jump(home, c);
    expect(first.body).toEqual({ chainLabel: null, deferred: true });
    expect(await sysLabel(c)).toBeNull();
    // The sig is matched: the system takes 3 straight away.
    await leadTo(sc, home, c);
    await new Promise((r) => setTimeout(r, 100));
    expect(await sysLabel(c)).toBe('3');
    // A settle afterwards changes nothing.
    expect((await request(app).post(`/api/maps/${mapId}/systems/${c}/chain-number`)
      .send({ fromSystemId: home, settle: true })).body.chainLabel).toBe('3');
    // Matched before the jump call: numbered at once.
    await leadTo(sa, home, a);
    await new Promise((r) => setTimeout(r, 100));
    expect(await sysLabel(a)).toBe('1');
  });

  it('an unreserved hole settles to the next free number, never a reserved one', async () => {
    const home = await system(true);
    const a = await system();
    await link(home, a);
    const s1 = await sig(home), s2 = await sig(home);
    await sig(home); // a third hole, not reserved
    await reserve(home, [s1, s2]); // 1, 2
    expect((await jump(home, a)).body.deferred).toBe(true);
    const settled = await request(app).post(`/api/maps/${mapId}/systems/${a}/chain-number`)
      .send({ fromSystemId: home, settle: true });
    expect(settled.body).toEqual({ chainLabel: '3', deferred: false });
  });

  it('without reservations a jump numbers at once, as before', async () => {
    const home = await system(true);
    const a = await system();
    await link(home, a);
    await sig(home);
    expect((await jump(home, a)).body).toEqual({ chainLabel: '1', deferred: false });
  });

  it('numbers deeper holes from a numbered system', async () => {
    const home = await system(true);
    const a = await system();
    await link(home, a);
    expect((await jump(home, a)).body.chainLabel).toBe('1');
    const x = await sig(a), y = await sig(a);
    expect((await reserve(a, [y, x])).body.reserved.map((r: { chainLabel: string }) => r.chainLabel)).toEqual(['11', '12']);
  });

  it('a reservation can be cleared until the hole is jumped, and its number is free again', async () => {
    const home = await system(true);
    const a = await system();
    await link(home, a);
    const s1 = await sig(home), s2 = await sig(home);
    await reserve(home, [s1]);
    const del = (id: string) => request(app).delete(`/api/maps/${mapId}/systems/${home}/signatures/${id}/chain-number`);
    expect((await del(s1)).status).toBe(200);
    expect(await sigLabel(s1)).toBeNull();
    expect((await reserve(home, [s2])).body.reserved[0].chainLabel).toBe('1');
    await leadTo(s2, home, a);
    await new Promise((r) => setTimeout(r, 100));
    expect(await sysLabel(a)).toBe('1');
    expect((await del(s2)).status).toBe(409);
  });

  it('reservations older than 48 hours are ignored', async () => {
    const home = await system(true);
    const a = await system();
    await link(home, a);
    const s1 = await sig(home);
    await reserve(home, [s1]);
    await db.query(`UPDATE map_signatures SET chain_reserved_at = NOW() - interval '49 hours' WHERE id = $1`, [s1]);
    expect((await jump(home, a)).body).toEqual({ chainLabel: '1', deferred: false });
  });

  it('a hand-edited number takes the reservations made under the old one with it', async () => {
    const home = await system(true);
    const a = await system();
    await link(home, a);
    await jump(home, a); // 1
    const x = await sig(a);
    await reserve(a, [x]); // 11
    await request(app).patch(`/api/maps/${mapId}/systems/${a}`).send({ chainLabel: '5' });
    expect(await sigLabel(x)).toBe('51');
  });

  it('renumbering a system by hand moves the chain beneath it', async () => {
    const home = await system(true);
    const set = (id: string, label: string) =>
      db.query(`UPDATE map_systems SET chain_label = $2 WHERE id = $1`, [id, label]);
    const [s7, s71, s73, s737, s2] = [await system(), await system(), await system(), await system(), await system()];
    await set(s7, '7'); await set(s71, '71'); await set(s73, '73'); await set(s737, '737'); await set(s2, '2');
    const r = await sig(s73);
    await reserve(s73, [r]); // 731
    void home;
    const patch = (id: string, chainLabel: string) =>
      request(app).patch(`/api/maps/${mapId}/systems/${id}`).send({ chainLabel });
    // 2 is still on the map, and 7 can't go beneath itself.
    expect((await patch(s7, '2')).status).toBe(409);
    expect((await patch(s7, '75')).status).toBe(409);
    expect(await sysLabel(s7)).toBe('7');
    expect((await patch(s7, '3')).status).toBe(200);
    expect([await sysLabel(s7), await sysLabel(s71), await sysLabel(s73), await sysLabel(s737)])
      .toEqual(['3', '31', '33', '337']);
    expect(await sigLabel(r)).toBe('331');
    expect(await sysLabel(s2)).toBe('2');
    // Past 9 the dots come in: 3 to 12 takes 337 to .12.3.7.
    expect((await patch(s7, '.12')).status).toBe(200);
    expect(await sysLabel(s737)).toBe('.12.3.7');
  });

  it('a deleted system put back loses its number if it went to another meanwhile', async () => {
    const home = await system(true);
    const a = await system(), b = await system();
    await link(home, a); await link(home, b);
    await jump(home, a); // 1
    expect((await request(app).delete(`/api/maps/${mapId}/systems/${a}`)).status).toBeLessThan(300);
    expect((await jump(home, b)).body.chainLabel).toBe('1');
    expect((await request(app).post(`/api/maps/${mapId}/systems/${a}/restore`)).status).toBe(200);
    expect(await sysLabel(a)).toBeNull();
    expect(await sysLabel(b)).toBe('1');
  });

  it('deleting or renumbering a system drops the numbers beneath it', async () => {
    const home = await system(true);
    const a = await system(), b = await system();
    await link(home, a); await link(home, b);
    const aa = await system(), aaa = await system(), ab = await system();
    await link(a, aa); await link(aa, aaa); await link(a, ab);
    await jump(home, a); await jump(home, b);        // 1, 2
    await jump(a, aa); await jump(aa, aaa);          // 11, 111
    await jump(a, ab);                               // 12
    const r = await sig(aa);
    await reserve(aa, [r]);                          // 112
    // 11 renumbered by hand: 111 and the reserved 112 go, 12 stays.
    await request(app).patch(`/api/maps/${mapId}/systems/${aa}`).send({ chainLabel: '' });
    expect(await sysLabel(aaa)).toBeNull();
    expect(await sigLabel(r)).toBeNull();
    expect(await sysLabel(ab)).toBe('12');
    // 1 deleted: 12 goes too, 2 stays.
    await request(app).delete(`/api/maps/${mapId}/systems/${a}`);
    expect(await sysLabel(ab)).toBeNull();
    expect(await sysLabel(b)).toBe('2');
  });

  it('dots keep a deep number apart from a wider one', async () => {
    const home = await system(true);
    const x = await system(), y = await system(), z = await system();
    await db.query(`UPDATE map_systems SET chain_label = $2 WHERE id = $1`, [x, '.11']);
    await db.query(`UPDATE map_systems SET chain_label = $2 WHERE id = $1`, [y, '.11.2']);
    await db.query(`UPDATE map_systems SET chain_label = $2 WHERE id = $1`, [z, '.110']);
    void home;
    await request(app).delete(`/api/maps/${mapId}/systems/${x}`);
    expect(await sysLabel(y)).toBeNull();
    expect(await sysLabel(z)).toBe('.110');
  });

  it('a system numbered from a reservation can be renumbered down and back', async () => {
    const home = await system(true);
    const a = await system(), b = await system();
    for (const s of [a, b]) await link(home, s);
    const sa = await sig(home), sb = await sig(home);
    await reserve(home, [sa, sb]); // 1, 2
    await leadTo(sa, home, a); await leadTo(sb, home, b);
    await new Promise((r) => setTimeout(r, 100));
    expect([await sysLabel(a), await sysLabel(b)]).toEqual(['1', '2']);
    const patch = (id: string, chainLabel: string | null) =>
      request(app).patch(`/api/maps/${mapId}/systems/${id}`).send({ chainLabel });
    // 2 to 3 and back: the hole's reservation follows, so 2 is free again.
    expect((await patch(b, '3')).status).toBe(200);
    expect(await sigLabel(sb)).toBe('3');
    expect((await patch(b, '2')).status).toBe(200);
    expect(await sigLabel(sb)).toBe('2');
    // Cleared by hand: the hole's reservation goes too.
    expect((await patch(b, null)).status).toBe(200);
    expect(await sigLabel(sb)).toBeNull();
    expect(await sigLabel(sa)).toBe('1');
  });

  it('says why a number beneath its own is refused', async () => {
    const a = await system();
    await db.query(`UPDATE map_systems SET chain_label = '31' WHERE id = $1`, [a]);
    const r = await request(app).patch(`/api/maps/${mapId}/systems/${a}`).send({ chainLabel: '3132' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('chain_label_beneath_own');
  });

  it('a copied map keeps its chain numbers and reservations', async () => {
    const home = await system(true);
    const a = await system();
    await link(home, a);
    await jump(home, a); // 1
    const x = await sig(a);
    await reserve(a, [x]); // 11
    const r = await request(app).post(`/api/maps/${mapId}/copy`).send({ name: 'C', include: { signatures: true } });
    expect(r.status).toBe(201);
    const { rows: [m] } = await db.query<{ on: boolean }>(`SELECT chain_numbering AS on FROM maps WHERE id = $1`, [r.body.id]);
    expect(m.on).toBe(true);
    const { rows } = await db.query<{ l: string }>(
      `SELECT chain_label AS l FROM map_systems WHERE map_id = $1 AND chain_label IS NOT NULL
       UNION ALL
       SELECT s.chain_label FROM map_signatures s JOIN map_systems y ON y.id = s.system_id
        WHERE y.map_id = $1 AND s.chain_reserved_at IS NOT NULL`, [r.body.id]);
    expect(rows.map((x) => x.l).sort()).toEqual(['1', '11']);
  });

  // Not a chain number, but the same PATCH and copy paths.
  it('keep can be set by any editor, survives a copy, and must be a boolean', async () => {
    const a = await system();
    const patch = (body: object) => request(app).patch(`/api/maps/${mapId}/systems/${a}`).send(body);
    expect((await patch({ keep: 'yes' })).status).toBe(400);
    await db.query(`UPDATE maps SET locked = TRUE WHERE id = $1`, [mapId]);
    expect((await patch({ keep: true })).status).toBe(200); // content, like notes: allowed on a locked map
    await db.query(`UPDATE maps SET locked = FALSE WHERE id = $1`, [mapId]);
    const r = await request(app).post(`/api/maps/${mapId}/copy`).send({ name: 'C', include: {} });
    const { rows } = await db.query<{ keep: boolean }>(`SELECT keep FROM map_systems WHERE map_id = $1`, [r.body.id]);
    expect(rows.map((x) => x.keep)).toEqual([true]);
  });
});
