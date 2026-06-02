import { createLogger } from './logger.js';

const log = createLogger('esi');

// Descriptive User-Agent with contact info, per CCP's ESI best practices — sent
// on every ESI request so they can identify (and reach) us instead of blocking.
const ESI_AGENT = 'Eve-Nexum/1.0 (https://github.com/GQuantrill/eve-nexum; gq@area404.org)';

// ── Error-limit backoff ──────────────────────────────────────────────────────
// ESI allows ~100 errors per 60s sliding window per IP; exceed it and every
// request 420s until the window resets. Each response carries the remaining
// budget + seconds-to-reset, so we watch those and stop sending when the budget
// runs low — shared module state because the limit is global to this process's
// IP, not per call site. Successful requests barely touch the budget, so under
// normal operation this never engages; it only bites when something is
// error-spamming (a bad token, a wrong id), which is exactly when CCP wants us
// to pause.
const SAFE_REMAIN = 10;       // start easing off once the budget dips this low
let blockedUntil = 0;         // epoch ms; hold new requests until this passes

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
  });
}

/**
 * Drop-in replacement for fetch() against ESI. Always sends the User-Agent and
 * Accept headers, and honours the error limit: if a recent response exhausted
 * the budget (or 420'd), new calls wait for the reset rather than piling on.
 * Returns the raw Response — callers do their own .ok / .json handling, exactly
 * as with fetch. The pre-request wait respects an AbortSignal in `init`, so a
 * caller with a timeout won't hang past it.
 */
export async function esiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const wait = blockedUntil - Date.now();
  if (wait > 0) await sleep(wait, init.signal);

  const headers = {
    'User-Agent': ESI_AGENT,
    Accept: 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  const res = await fetch(url, { ...init, headers });

  // Update backoff state from the error-limit headers (present on every ESI
  // response). Reset is seconds until the window clears; pad by 1s.
  const remainRaw = res.headers.get('x-esi-error-limit-remain');
  if (remainRaw != null || res.status === 420) {
    const remain   = remainRaw != null ? parseInt(remainRaw, 10) : 0;
    const resetSec = parseInt(res.headers.get('x-esi-error-limit-reset') ?? '60', 10);
    if (res.status === 420 || remain <= 0) {
      blockedUntil = Date.now() + (resetSec + 1) * 1000;
      log.warn(`error limit hit (status ${res.status}); backing off ${resetSec + 1}s`);
    } else if (remain <= SAFE_REMAIN) {
      // Close to the edge — brief pause so a burst doesn't blow the window.
      blockedUntil = Date.now() + 1000;
      log.warn(`error limit low (${remain} left); easing off`);
    }
  }
  return res;
}
