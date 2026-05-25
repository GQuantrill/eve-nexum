import type { QueryResult, QueryResultRow } from 'pg';
import { db } from '../db.js';

// Minimal surface both a Pool and a PoolClient satisfy — lets callers pass a
// transaction client so the audit row commits/rolls back with the change it
// describes (used by the map merge), defaulting to the global pool otherwise.
export interface QueryExecutor {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<R>>;
}

// Write an admin audit entry. Wraps the verbose 7-column insert. `exec`
// defaults to the shared pool; pass a transaction client to make the audit
// row part of an enclosing transaction.
export async function audit(
  req: { session: { userId?: number; characterId?: number } },
  targetUserId: number | null,
  targetCharacterId: number | null,
  action: string,
  oldValue: string | null,
  newValue: string | null,
  exec: QueryExecutor = db,
): Promise<void> {
  await exec.query(
    `INSERT INTO admin_audit
       (actor_user_id, actor_character_id, target_user_id, target_character_id, action, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [req.session.userId, req.session.characterId, targetUserId, targetCharacterId, action, oldValue, newValue],
  );
}
