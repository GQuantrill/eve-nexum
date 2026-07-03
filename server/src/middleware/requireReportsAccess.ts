import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { isAdmin } from './authContext.js';

// Allow the reports character (cluster-wide intel) OR any admin. A corp admin
// is corp-scoped; an alliance admin is alliance-scoped. Per-route handlers
// branch on isReportsCharacter() / corpScopeFor() to decide the filter.
export function requireReportsAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (!isReportsCharacter(req) && !isAdmin(req.session.role ?? 'readonly')) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

export function isReportsCharacter(req: Request): boolean {
  return config.reportsCharId !== null && req.session.characterId === config.reportsCharId;
}

// SQL fragment + param to scope a query to the caller's visible maps.
// Reports character → no filter; alliance admin → `m.alliance_id = $N` (their
// alliance's maps); corp admin → `m.corp_id = $N`. Returns null when the caller
// has no matching affiliation (caller should 403).
export function corpScopeFor(req: Request): { sql: (paramIndex: number) => string; param: number | null } | null {
  if (isReportsCharacter(req)) {
    return { sql: () => 'TRUE', param: null };
  }
  if (req.session.role === 'alliance_admin') {
    const alliance = req.session.userAllianceId;
    if (alliance == null) return null;
    return { sql: (i) => `m.alliance_id = $${i}`, param: alliance };
  }
  const corp = req.session.userCorpId;
  if (corp == null) return null;
  return { sql: (i) => `m.corp_id = $${i}`, param: corp };
}
