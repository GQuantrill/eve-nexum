import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { routePlansRouter } from './routePlans.js';

const dbReady = await ensureIntegrationDb();

const JITA = 30000142, AMARR = 30002187, RENS = 30002510;

// Plans are keyed on the ACCOUNT (owner), not the character, so an alt sees the
// same saved routes — and someone else's account must see none of them. Running
// the real SQL is the point: the owner_id predicate is the whole access check.
function appFor(userId: number, ownerId: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = {
      userId, characterId: userId, role: 'full', ownerId,
    };
    next();
  });
  app.use('/api/route-plans', routePlansRouter);
  return app;
}

async function newOwner(): Promise<number> {
  const { rows } = await db.query<{ id: number }>(`INSERT INTO owners DEFAULT VALUES RETURNING id`);
  return rows[0].id;
}

describe.skipIf(!dbReady)('route-plans (integration)', () => {
  let mineOwner: number, mine: number;
  let theirsOwner: number, theirs: number;

  beforeEach(async () => {
    await truncateAll();
    mineOwner = await newOwner();
    mine = await seedUser({ characterId: 101, role: 'full' });
    await db.query(`UPDATE users SET owner_id = $1 WHERE id = $2`, [mineOwner, mine]);
    theirsOwner = await newOwner();
    theirs = await seedUser({ characterId: 202, role: 'full' });
    await db.query(`UPDATE users SET owner_id = $1 WHERE id = $2`, [theirsOwner, theirs]);
  });

  it('saves a route and reads it back for the same account', async () => {
    const app = appFor(mine, mineOwner);
    await request(app).post('/api/route-plans')
      .send({ name: 'Trade run', fromEveId: JITA, toEveId: AMARR }).expect(200);

    const { body } = await request(app).get('/api/route-plans').expect(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ name: 'Trade run', fromEveId: JITA, toEveId: AMARR });
  });

  it('never shows one account the routes saved by another', async () => {
    await request(appFor(mine, mineOwner)).post('/api/route-plans')
      .send({ name: 'Mine', fromEveId: JITA, toEveId: AMARR }).expect(200);

    // Control: the owner who saved it does see it, so the emptiness below is
    // about scoping rather than the save having silently failed.
    const ours = await request(appFor(mine, mineOwner)).get('/api/route-plans').expect(200);
    expect(ours.body).toHaveLength(1);

    const theirList = await request(appFor(theirs, theirsOwner)).get('/api/route-plans').expect(200);
    expect(theirList.body).toEqual([]);
  });

  it('refuses to delete a route belonging to another account', async () => {
    await request(appFor(mine, mineOwner)).post('/api/route-plans')
      .send({ name: 'Mine', fromEveId: JITA, toEveId: RENS }).expect(200);
    const { body } = await request(appFor(mine, mineOwner)).get('/api/route-plans');
    const id = body[0].id;

    // Answers ok — there is simply no row matching both the id and THEIR owner.
    await request(appFor(theirs, theirsOwner)).delete(`/api/route-plans/${id}`).expect(200);

    const after = await request(appFor(mine, mineOwner)).get('/api/route-plans').expect(200);
    expect(after.body).toHaveLength(1);
  });

  it('deletes its own route', async () => {
    const app = appFor(mine, mineOwner);
    await request(app).post('/api/route-plans')
      .send({ name: 'Mine', fromEveId: JITA, toEveId: RENS }).expect(200);
    const { body } = await request(app).get('/api/route-plans');
    await request(app).delete(`/api/route-plans/${body[0].id}`).expect(200);
    const after = await request(app).get('/api/route-plans').expect(200);
    expect(after.body).toEqual([]);
  });

  it('rejects a nameless plan, and one that goes nowhere', async () => {
    const app = appFor(mine, mineOwner);
    await request(app).post('/api/route-plans').send({ fromEveId: JITA, toEveId: AMARR }).expect(400);
    await request(app).post('/api/route-plans')
      .send({ name: 'Nowhere', fromEveId: JITA, toEveId: JITA }).expect(400);
    const { body } = await request(app).get('/api/route-plans').expect(200);
    expect(body).toEqual([]);
  });
});
