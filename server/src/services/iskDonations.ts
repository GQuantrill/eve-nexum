import { db } from '../db.js';
import { config } from '../config.js';
import { esiFetch } from '../utils/esi.js';
import { decryptToken, encryptToken } from '../utils/tokenCrypto.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('isk-donations');

const EVE_TOKEN_URL = 'https://login.eveonline.com/v2/oauth/token';

/** The one scope the wallet reader needs. Deliberately NOT in SSO_SCOPES. */
export const WALLET_SCOPE = 'esi-wallet.read_corporation_wallets.v1';

/**
 * Turning ISK donations into extra personal maps.
 *
 * The donation corp's wallet journal is polled and every `player_donation` to
 * that corp is recorded against the donor's account, which raises their map cap
 * (see services/mapAllowance.ts).
 *
 * Three facts from the ESI contract shape all of this:
 *
 *   - The journal is cached for an HOUR server-side. Polling faster re-reads the
 *     same page, so a donation can take up to an hour to land and the UI has to
 *     say so rather than implying it is instant.
 *   - It only goes back 30 DAYS. If this poller is down longer than that, those
 *     entries are gone from ESI for good — hence last_error / last_ok_at being
 *     surfaced to an admin instead of failing quietly.
 *   - It needs the in-game Accountant or Junior_Accountant role, so it runs on
 *     one operator token rather than anything the donor grants.
 */
export interface JournalEntry {
  id:               number;
  ref_type:         string;
  amount?:          number;
  date:             string;
  first_party_id?:  number;
  second_party_id?: number;
  reason?:          string;
}

interface ReaderRow {
  character_id:  number;
  refresh_token: string;
  credit_from:   Date;
}

function configured(): boolean {
  return config.iskMaps.enabled
    && config.iskMaps.corpId > 0
    && config.iskMaps.readerCharId > 0;
}

async function readerRow(): Promise<ReaderRow | null> {
  const { rows } = await db.query<ReaderRow>(
    `SELECT character_id, refresh_token, credit_from FROM wallet_reader WHERE character_id = $1`,
    [config.iskMaps.readerCharId],
  );
  return rows[0] ?? null;
}

/**
 * Exchange the reader's refresh token for an access token. EVE ROTATES refresh
 * tokens on use, so the new one is persisted immediately — dropping it would
 * strand the reader on a token that no longer works and need a manual reconnect.
 */
async function readerAccessToken(row: ReaderRow): Promise<string> {
  const res = await fetch(EVE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${process.env.EVE_CLIENT_ID}:${process.env.EVE_CLIENT_SECRET}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: decryptToken(row.refresh_token) }),
  });
  if (!res.ok) throw new Error(`token refresh failed (${res.status})`);

  const t = await res.json() as { access_token: string; refresh_token: string };
  await db.query(
    `UPDATE wallet_reader SET refresh_token = $1 WHERE character_id = $2`,
    [encryptToken(t.refresh_token), row.character_id],
  );
  return t.access_token;
}

/** One page of the journal. Returns the entries and the total page count. */
async function fetchPage(token: string, page: number): Promise<{ entries: JournalEntry[]; pages: number }> {
  const url = `https://esi.evetech.net/latest/corporations/${config.iskMaps.corpId}`
    + `/wallets/${config.iskMaps.division}/journal/?page=${page}`;
  const res = await esiFetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (res.status === 403) {
    // Almost always the in-game role being removed, or the character leaving the
    // corporation. Worth naming, because the symptom is silence.
    throw new Error('403 from the wallet journal — does the reader still hold Accountant / Junior Accountant in this corp?');
  }
  if (!res.ok) throw new Error(`journal page ${page} returned ${res.status}`);

  return {
    entries: await res.json() as JournalEntry[],
    pages:   parseInt(res.headers.get('x-pages') ?? '1', 10) || 1,
  };
}

/**
 * Record one journal entry. ON CONFLICT DO NOTHING against ESI's own unique
 * journal id is what makes re-reading a cached page harmless — without it the
 * hourly cache would re-credit the same donation on every poll.
 *
 * An unmatched donor (a character not linked to any account) is stored with a
 * NULL owner rather than dropped: it shows up for an admin to assign, and the
 * re-match pass below picks it up automatically if they link that character later.
 */
export async function recordDonation(e: JournalEntry): Promise<void> {
  await db.query(
    `INSERT INTO isk_donations (journal_id, character_id, owner_id, amount, reason, occurred_at)
     VALUES ($1, $2::int, (SELECT owner_id FROM users WHERE character_id = $2::int), $3, $4, $5)
     ON CONFLICT (journal_id) DO NOTHING`,
    [e.id, e.first_party_id ?? 0, e.amount ?? 0, (e.reason ?? '').slice(0, 500), e.date],
  );
}

/**
 * Attach any still-unmatched donations to an account that has since linked the
 * donating character. Means "donate from an alt, then add that alt" resolves
 * itself instead of becoming a support request.
 */
export async function rematchOrphans(): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE isk_donations d
        SET owner_id = u.owner_id
       FROM users u
      WHERE d.owner_id IS NULL
        AND u.character_id = d.character_id
        AND u.owner_id IS NOT NULL`,
  );
  return rowCount ?? 0;
}

export async function pollDonations(): Promise<void> {
  if (!configured()) return;

  const row = await readerRow();
  if (!row) return;                       // no reader connected yet

  try {
    const token = await readerAccessToken(row);
    const cutoff = new Date(row.credit_from).getTime();

    let page = 1, pages = 1, seen = 0;
    do {
      const { entries, pages: total } = await fetchPage(token, page);
      pages = total;
      for (const e of entries) {
        if (e.ref_type !== 'player_donation') continue;
        if (e.second_party_id !== config.iskMaps.corpId) continue;   // paid out, not in
        if (!e.amount || e.amount <= 0) continue;
        if (!e.first_party_id) continue;
        if (new Date(e.date).getTime() < cutoff) continue;           // predates the reader
        await recordDonation(e);
        seen++;
      }
      page++;
    } while (page <= pages);

    const rematched = await rematchOrphans();
    await db.query(
      `UPDATE wallet_reader SET last_ok_at = NOW(), last_error = NULL WHERE character_id = $1`,
      [row.character_id],
    );
    if (seen || rematched) log.info(`processed ${seen} donation entries, re-matched ${rematched} orphan(s)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Persisted, not just logged: a reader that has quietly stopped crediting
    // people is the failure that generates angry messages, so it has to be
    // visible in the admin page.
    await db.query(
      `UPDATE wallet_reader SET last_error = $1 WHERE character_id = $2`,
      [msg.slice(0, 500), row.character_id],
    ).catch(() => { /* the error path must not throw */ });
    log.error('donation poll failed:', msg);
  }
}

export function startIskDonationPoller(): void {
  if (!configured()) return;
  const mins = config.iskMaps.pollMinutes;
  log.info(`ISK-for-maps enabled (corp ${config.iskMaps.corpId}, polling every ${mins} min)`);
  setTimeout(() => { void pollDonations(); }, 60_000);
  setInterval(() => { void pollDonations(); }, mins * 60_000);
}
