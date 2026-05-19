import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

// Allow the reports character (cluster-wide intel) OR any admin
// (corp-scoped). Per-route handlers branch on isReportsCharacter() to
// decide whether to apply the m.corp_id = mycorp filter.
export function requireReportsAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (!isReportsCharacter(req) && req.session.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

export function isReportsCharacter(req: Request): boolean {
  return config.reportsCharId !== null && req.session.characterId === config.reportsCharId;
}

// SQL fragment + param to scope a query to the caller's visible maps.
// Reports character → no filter; admin → `m.corp_id = $N`. Returns null
// when an admin has no corp affiliation (shouldn't happen in corp mode,
// but defensive — caller should 403).
export function corpScopeFor(req: Request): { sql: (paramIndex: number) => string; param: number | null } | null {
  if (isReportsCharacter(req)) {
    return { sql: () => 'TRUE', param: null };
  }
  const corp = req.session.userCorpId;
  if (corp == null) return null;
  return { sql: (i) => `m.corp_id = $${i}`, param: corp };
}
