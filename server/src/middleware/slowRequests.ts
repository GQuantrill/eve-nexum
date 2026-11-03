import type { NextFunction, Request, Response } from 'express';
import { createLogger } from '../utils/logger.js';

const log = createLogger('slow');

// Requests at or over this are logged. Normal API calls answer in tens of ms;
// a few seconds means something is wrong.
const SLOW_MS = 3_000;

// Path only: the query string can carry an SSO code or state, and a share
// link's token is the whole credential, so neither is written to the log.
function logPath(req: Request): string {
  return req.originalUrl.split('?')[0].replace(/^\/api\/share\/[^/]+/, '/api/share/:token');
}

/**
 * Logs requests that take SLOW_MS or longer, and ones abandoned before an
 * answer was sent (the browser or Cloudflare gave up -- Cloudflare's limit is
 * 100s). Added to find out which call stalls when a map switch hangs; it costs
 * one timestamp per request. Live-update streams are skipped: they stay open
 * by design.
 */
export function slowRequests(req: Request, res: Response, next: NextFunction): void {
  if (req.path.endsWith('/events')) { next(); return; }
  const start = performance.now();
  let done = false;
  const report = (finished: boolean) => {
    if (done) return;
    done = true;
    const ms = Math.round(performance.now() - start);
    if (finished && ms >= SLOW_MS) {
      log.warn(`slow request ${req.method} ${logPath(req)} -> ${res.statusCode} in ${ms}ms`);
    } else if (!finished && ms >= SLOW_MS) {
      log.warn(`request abandoned ${req.method} ${logPath(req)} after ${ms}ms, no response sent`);
    }
  };
  res.on('finish', () => report(true));
  res.on('close', () => report(res.writableFinished));
  next();
}
