import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { resolveOwnerId } from '../utils/owner.js';
import { generateApiKey } from '../utils/apiKeys.js';
import { audit } from '../services/audit.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('keys');

// Management API for the user's own external API keys. Cookie/session-authed
// (NOT key-authed — you can't mint keys with a key). A key is account-scoped:
// it acts as the caller's owner with one bound character for role/corp context.
// See external_api_feature.md.
export const keysRouter = Router();
keysRouter.use(requireAuth);

const MAX_KEYS_PER_OWNER = 25;
const VALID_SCOPES = new Set(['read', 'events']);
// api_tokens.id is a uuid; Postgres throws 22P02 on malformed input, so guard
// the path param up front and treat a bad shape as a clean 404.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// GET /api/keys — list the owner's keys. Never returns the secret (only the
// stored prefix + metadata); the raw key is shown once at creation and never
// recoverable.
keysRouter.get('/', async (req, res) => {
  const ownerId = await resolveOwnerId(req);
  if (ownerId == null) { res.status(401).json({ error: 'Not authenticated' }); return; }

  const { rows } = await db.query(
    `SELECT t.id,
            t.name,
            t.token_prefix     AS "tokenPrefix",
            t.scope,
            t.context_user_id  AS "contextUserId",
            u.character_name   AS "contextCharacterName",
            t.last_used_at     AS "lastUsedAt",
            t.expires_at       AS "expiresAt",
            t.created_at       AS "createdAt"
       FROM api_tokens t
       LEFT JOIN users u ON u.id = t.context_user_id
      WHERE t.owner_id = $1
      ORDER BY t.created_at DESC`,
    [ownerId],
  );
  res.json({ keys: rows, maxKeys: MAX_KEYS_PER_OWNER });
});

// POST /api/keys — create a key bound to one of the account's characters.
// Body: { name, contextCharacterId, scope?, expiresAt? }. Returns the raw key
// exactly once.
keysRouter.post('/', async (req, res) => {
  const ownerId = await resolveOwnerId(req);
  if (ownerId == null) { res.status(401).json({ error: 'Not authenticated' }); return; }

  const body = req.body as {
    name?: unknown; contextCharacterId?: unknown; scope?: unknown; expiresAt?: unknown;
  };

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 60) {
    res.status(400).json({ error: 'A name (1-60 chars) is required' }); return;
  }

  const scope = body.scope == null ? 'read' : String(body.scope);
  if (!VALID_SCOPES.has(scope)) {
    res.status(400).json({ error: 'scope must be "read" or "events"' }); return;
  }

  // expiresAt is optional; if given it must be a valid future timestamp.
  let expiresAt: Date | null = null;
  if (body.expiresAt != null && body.expiresAt !== '') {
    const d = new Date(String(body.expiresAt));
    if (Number.isNaN(d.getTime())) { res.status(400).json({ error: 'Invalid expiresAt' }); return; }
    if (d.getTime() <= Date.now()) { res.status(400).json({ error: 'expiresAt must be in the future' }); return; }
    expiresAt = d;
  }

  // The bound character must belong to THIS account — you can only grant a key
  // the context of a character you own. contextCharacterId is the EVE
  // character_id; resolve it to the users row and verify ownership.
  const contextCharacterId = Number(body.contextCharacterId);
  if (!Number.isInteger(contextCharacterId)) {
    res.status(400).json({ error: 'contextCharacterId is required' }); return;
  }
  const { rows: charRows } = await db.query<{ id: number; ownerId: number | null }>(
    `SELECT id, owner_id AS "ownerId" FROM users WHERE character_id = $1`,
    [contextCharacterId],
  );
  const ctx = charRows[0];
  if (!ctx || ctx.ownerId !== ownerId) {
    res.status(400).json({ error: 'contextCharacterId must be a character on your account' }); return;
  }

  // Per-account cap — a soft guard against runaway key creation.
  const { rowCount } = await db.query(`SELECT 1 FROM api_tokens WHERE owner_id = $1`, [ownerId]);
  if ((rowCount ?? 0) >= MAX_KEYS_PER_OWNER) {
    res.status(409).json({ error: `Key limit reached (${MAX_KEYS_PER_OWNER})` }); return;
  }

  const key = generateApiKey();
  const { rows } = await db.query<{ id: string; createdAt: string }>(
    `INSERT INTO api_tokens
       (owner_id, context_user_id, token_hash, token_prefix, name, scope, expires_at, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at AS "createdAt"`,
    [ownerId, ctx.id, key.hash, key.prefix, name, scope, expiresAt, req.session.userId],
  );
  const created = rows[0];

  await audit(req, ctx.id, contextCharacterId, 'api_key_create', null, `${name} (${scope})`)
    .catch((err) => log.warn(`audit api_key_create failed: ${err}`));

  // The ONLY time the raw key is returned. The client must surface it for copy
  // and warn it cannot be shown again.
  res.status(201).json({
    id: created.id,
    name,
    scope,
    tokenPrefix: key.prefix,
    expiresAt,
    createdAt: created.createdAt,
    key: key.raw,
  });
});

// DELETE /api/keys/:id — revoke. Scoped to the owner so you can only delete
// your own keys.
keysRouter.delete('/:id', async (req, res) => {
  const ownerId = await resolveOwnerId(req);
  if (ownerId == null) { res.status(401).json({ error: 'Not authenticated' }); return; }
  if (!UUID_RE.test(req.params.id)) { res.status(404).json({ error: 'Key not found' }); return; }

  const { rows } = await db.query<{ id: string; name: string; contextUserId: number | null }>(
    `DELETE FROM api_tokens
      WHERE id = $1 AND owner_id = $2
      RETURNING id, name, context_user_id AS "contextUserId"`,
    [req.params.id, ownerId],
  );
  if (!rows.length) { res.status(404).json({ error: 'Key not found' }); return; }

  await audit(req, rows[0].contextUserId, null, 'api_key_revoke', rows[0].name, null)
    .catch((err) => log.warn(`audit api_key_revoke failed: ${err}`));

  // Return a JSON body (not 204) — the shared web api() client always parses
  // the response as JSON, so an empty body would surface as a bogus error.
  res.json({ ok: true });
});
