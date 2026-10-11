import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Watch the outbound side rather than the dispatcher: what matters is whether
// a message actually reaches Discord, not which branch decided it shouldn't.
const sent = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('../services/discord.js', () => ({
  notifyDiscord: (...args: unknown[]) => { sent.calls.push(args); return Promise.resolve(); },
  k162Embed:       () => ({}),
  connectionEmbed: () => ({}),
  chainEmbed:      () => ({}),
  kspaceExitEmbed: () => ({}),
}));

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { mapsRouter } from './maps.js';

const dbReady = await ensureIntegrationDb();

const CORP = 98000001;
const WEBHOOK = 'https://discord.com/api/webhooks/1/abc';
// A notice is deferred 10s to give a leads-to time to arrive -- far too long
// to wait here. Filling the leads-to flushes it immediately instead, which is
// the ordinary flow anyway: scan the K162, then find out where it goes.
const SETTLE_MS = 800;
// A leads-to of literally "Thera" is a class/band token and never notifies.
// The row that WOULD notify is the hub-side one, whose leads-to is the far
// system — so that is the case worth testing. ("Turnur" is not a band token,
// so a far-side K162 pointing at it would notify too.)
const DEST = 'J154934';

function appFor(userId: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session: Record<string, unknown> }).session = {
      userId, characterId: userId, userCorpId: CORP,
    };
    next();
  });
  app.use('/api/maps', mapsRouter);
  return app;
}

describe.skipIf(!dbReady)('K162 Discord notice vs the scout copy button (integration)', () => {
  let user: number, mapId: string, sysId: string;

  beforeEach(async () => {
    await truncateAll();
    sent.calls = [];
    user = await seedUser({ characterId: 1, name: 'Scout', corpId: CORP, role: 'admin' });
    // A corp map with K162 pings ON and a webhook — i.e. every condition for a
    // notice met, so a silent test means suppression and not a missing setting.
    mapId = (await db.query<{ id: string }>(
      `INSERT INTO maps (name, user_id, corp_id) VALUES ('m', $1, $2) RETURNING id`,
      [user, CORP])).rows[0].id;
    sysId = (await db.query<{ id: string }>(
      `INSERT INTO map_systems (id, map_id, name, system_class, position_x, position_y)
       VALUES (gen_random_uuid(), $1, 'Isamm', 'LS', 0, 0) RETURNING id`, [mapId])).rows[0].id;
    // Not covered by truncateAll, so upsert rather than insert.
    await db.query(
      `INSERT INTO corp_discord_settings (corp_id, notify_k162, connections_webhook)
       VALUES ($1, TRUE, $2)
       ON CONFLICT (corp_id) DO UPDATE SET notify_k162 = TRUE, connections_webhook = $2`,
      [CORP, WEBHOOK]);
  });

  const postSig = (body: Record<string, unknown>) =>
    request(appFor(user)).post(`/api/maps/${mapId}/systems/${sysId}/signatures`).send(body);

  const patchSig = (id: string, body: Record<string, unknown>) =>
    request(appFor(user)).patch(`/api/maps/${mapId}/systems/${sysId}/signatures/${id}`).send(body);

  /** Give the flushed send its real DB round-trip; returns as soon as one lands,
   *  so only the cases asserting silence pay the full wait. */
  async function settle() {
    const until = Date.now() + SETTLE_MS;
    while (sent.calls.length === 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('announces a K162 a pilot scanned', async () => {
    // The control. Without this passing the suppression cases prove nothing —
    // a silent Discord could just mean a setting is missing.
    const { body } = await postSig({ sigId: 'ABC-123', sigType: 'wormhole', whType: 'K162' })
      .expect(201);
    await patchSig(body.id, { whLeadsTo: DEST }).expect(200);
    await settle();
    expect(sent.calls).toHaveLength(1);
  });

  it('stays quiet for a K162 the Thera/Turnur copy button wrote', async () => {
    // Every wormhole is K162 at one end, so half of a bulk copy is K162 and
    // this would otherwise fire a notice per connection — for holes already on
    // a public listing the pilot is reading as they press the button.
    const { body } = await postSig({ sigId: 'ABC-123', sigType: 'wormhole', whType: 'K162',
                                     scoutConnectionId: '75570' }).expect(201);
    await patchSig(body.id, { whLeadsTo: DEST, scoutConnectionId: '75570' }).expect(200);
    await settle();
    expect(sent.calls).toHaveLength(0);
  });

  it('stays quiet when a repeat copy corrects an existing row to K162', async () => {
    // The upsert path: a row written under the old behaviour carries the real
    // code at both ends, and re-copying corrects one to K162. A correction is
    // not a sighting.
    const { body } = await postSig({ sigId: 'ABC-123', sigType: 'wormhole', whType: 'C729',
                                     scoutConnectionId: '75570' }).expect(201);
    await patchSig(body.id, { whType: 'K162', whLeadsTo: DEST, scoutConnectionId: '75570' })
      .expect(200);
    await settle();
    expect(sent.calls).toHaveLength(0);
  });

  it('still announces when a pilot edits a hole to K162 by hand', async () => {
    // Same PATCH route, no provenance: suppression keys off the marker the
    // copy button stamps, not off the shape of the edit.
    const { body } = await postSig({ sigId: 'DEF-456', sigType: 'wormhole', whType: '' })
      .expect(201);
    await patchSig(body.id, { whType: 'K162' }).expect(200);
    await patchSig(body.id, { whLeadsTo: DEST }).expect(200);
    await settle();
    expect(sent.calls).toHaveLength(1);
  });
});
