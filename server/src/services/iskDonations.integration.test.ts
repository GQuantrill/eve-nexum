import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({ over: {} as Record<string, unknown> }));
vi.mock('../config.js', async (importActual) => {
  const base = (await importActual<typeof import('../config.js')>()).config as Record<string, unknown>;
  return { config: new Proxy({}, { get: (_t, k: string) => (k in state.over ? state.over[k] : base[k]) }) };
});

import { ensureIntegrationDb, truncateAll, seedUser } from '../test/integrationDb.js';
import { db } from '../db.js';
import { recordDonation, rematchOrphans, type JournalEntry } from './iskDonations.js';
import { mapCapFor } from './mapAllowance.js';

const dbReady = await ensureIntegrationDb();

const CORP  = 98120330;      // the donation corp
const PRICE = 500_000_000;
const BASE  = 5;             // MAX_USER_MAPS under test

let journalSeq = 1;
function entry(characterId: number, amount: number, over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: journalSeq++, ref_type: 'player_donation', amount,
    date: new Date().toISOString(),
    first_party_id: characterId, second_party_id: CORP, ...over,
  };
}

async function ownerOf(userId: number): Promise<number> {
  const { rows } = await db.query<{ owner_id: number }>(`SELECT owner_id FROM users WHERE id = $1`, [userId]);
  return rows[0].owner_id;
}

// Give a seeded user an account, the way real login does.
async function withOwner(characterId: number): Promise<{ userId: number; ownerId: number }> {
  const userId = await seedUser({ characterId, role: 'full' });
  const { rows } = await db.query<{ id: number }>(`INSERT INTO owners DEFAULT VALUES RETURNING id`);
  await db.query(`UPDATE users SET owner_id = $1 WHERE id = $2`, [rows[0].id, userId]);
  return { userId, ownerId: rows[0].id };
}

// This is the only code in the app where a bug costs someone real ISK, so the
// arithmetic and the idempotency are pinned down rather than eyeballed.
describe.skipIf(!dbReady)('ISK for maps (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    journalSeq = 1;
    state.over = {
      maxUserMaps: BASE,
      iskMaps: { enabled: true, corpId: CORP, readerCharId: 92961862, division: 1,
                 priceIsk: PRICE, mapsPerGrant: 5, pollMinutes: 15 },
    };
  });

  it('leaves an account that has donated nothing on the base cap', async () => {
    const { ownerId } = await withOwner(1);
    expect(await mapCapFor(ownerId)).toBe(BASE);
  });

  it('grants 5 maps for a 500m donation', async () => {
    const { ownerId } = await withOwner(1);
    await recordDonation(entry(1, PRICE));
    expect(await mapCapFor(ownerId)).toBe(BASE + 5);
  });

  it('grants twice over for a single 1b donation', async () => {
    const { ownerId } = await withOwner(1);
    await recordDonation(entry(1, 2 * PRICE));
    expect(await mapCapFor(ownerId)).toBe(BASE + 10);
  });

  // The reason entitlement accumulates instead of counting donations: two half
  // payments are a grant, not two discarded ones.
  it('adds partial donations together into a grant', async () => {
    const { ownerId } = await withOwner(1);
    await recordDonation(entry(1, 300_000_000));
    expect(await mapCapFor(ownerId)).toBe(BASE);
    await recordDonation(entry(1, 200_000_000));
    expect(await mapCapFor(ownerId)).toBe(BASE + 5);
  });

  it('does not grant for less than the price', async () => {
    const { ownerId } = await withOwner(1);
    await recordDonation(entry(1, 499_999_999));
    expect(await mapCapFor(ownerId)).toBe(BASE);
  });

  // The hourly ESI cache means the same page is re-read constantly, so this is
  // the single most important property here.
  it('credits a repeated journal entry exactly once', async () => {
    const { ownerId } = await withOwner(1);
    const e = entry(1, PRICE);
    await recordDonation(e);
    await recordDonation(e);
    await recordDonation(e);
    expect(await mapCapFor(ownerId)).toBe(BASE + 5);
    const { rows } = await db.query<{ n: string }>(`SELECT COUNT(*) AS n FROM isk_donations`);
    expect(rows[0].n).toBe('1');
  });

  it('credits every character of an account to the same allowance', async () => {
    const { ownerId } = await withOwner(1);
    const alt = await seedUser({ characterId: 2, role: 'full' });
    await db.query(`UPDATE users SET owner_id = $1 WHERE id = $2`, [ownerId, alt]);
    await recordDonation(entry(1, PRICE));
    await recordDonation(entry(2, PRICE));
    expect(await mapCapFor(ownerId)).toBe(BASE + 10);
  });

  it('never credits one account for another account s donation', async () => {
    const a = await withOwner(1);
    const b = await withOwner(2);
    await recordDonation(entry(1, PRICE));
    expect(await mapCapFor(a.ownerId)).toBe(BASE + 5);
    expect(await mapCapFor(b.ownerId)).toBe(BASE);
  });

  it('holds a donation from an unlinked character instead of dropping it', async () => {
    await recordDonation(entry(9999, PRICE));      // nobody owns character 9999
    const { rows } = await db.query(`SELECT owner_id, amount FROM isk_donations`);
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_id).toBeNull();
  });

  // Donate from an alt, then link the alt: it should resolve itself rather than
  // becoming a support request.
  it('credits a held donation once its character is linked to an account', async () => {
    await recordDonation(entry(4242, PRICE));
    const { ownerId } = await withOwner(4242);
    expect(await mapCapFor(ownerId)).toBe(BASE);   // not yet re-matched

    expect(await rematchOrphans()).toBe(1);
    expect(await mapCapFor(ownerId)).toBe(BASE + 5);
  });

  it('adds a manual admin bonus on top of donated maps', async () => {
    const { ownerId } = await withOwner(1);
    await recordDonation(entry(1, PRICE));
    await db.query(`UPDATE owners SET map_bonus = 3 WHERE id = $1`, [ownerId]);
    expect(await mapCapFor(ownerId)).toBe(BASE + 5 + 3);
  });

  it('applies a negative bonus without ever going below zero', async () => {
    const { ownerId } = await withOwner(1);
    await db.query(`UPDATE owners SET map_bonus = -99 WHERE id = $1`, [ownerId]);
    expect(await mapCapFor(ownerId)).toBe(0);
  });

  // Turning the feature off must not strip an allowance an admin granted by
  // hand, but it must stop donations counting.
  it('ignores donations when the feature is off, but keeps the manual bonus', async () => {
    const { ownerId } = await withOwner(1);
    await recordDonation(entry(1, PRICE));
    await db.query(`UPDATE owners SET map_bonus = 2 WHERE id = $1`, [ownerId]);
    state.over.iskMaps = { ...(state.over.iskMaps as object), enabled: false };
    expect(await mapCapFor(ownerId)).toBe(BASE + 2);
  });

  it('falls back to the base cap for a caller with no account', async () => {
    expect(await mapCapFor(null)).toBe(BASE);
  });
});
