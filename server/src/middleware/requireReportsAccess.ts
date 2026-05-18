import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

export function requireReportsAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (config.reportsCharId === null || req.session.characterId !== config.reportsCharId) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}
