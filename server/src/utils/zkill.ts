// zKillboard asks every client to send a reachable contact in its User-Agent
// (a blank one is blocked by Cloudflare).
export const ZKB_AGENT = 'Eve-Nexum/1.0 (https://github.com/GQuantrill/eve-nexum; gq@area404.org)';

// When zKill stops answering, every kills-panel request would otherwise wait
// out the full fetch timeout (8s) before falling back. After one timeout or
// network failure we stop asking for ZKILL_PAUSE_MS and answer straight away
// from the cache and the live feed instead.
export const ZKILL_PAUSE_MS = 60_000;
let pausedUntil = 0;

/** True while zKill calls are paused after a recent failure. */
export function zkillPaused(now = Date.now()): boolean {
  return now < pausedUntil;
}

/** Call from a zKill fetch's catch: a timeout or network failure pauses zKill
 *  calls; anything else (a bad body, say) doesn't. */
export function noteZkillFailure(err: unknown, now = Date.now()): void {
  const name = (err as Error | undefined)?.name;
  if (name === 'TimeoutError' || name === 'AbortError' || name === 'TypeError') {
    pausedUntil = now + ZKILL_PAUSE_MS;
  }
}

/** For tests. */
export function resetZkillPause(): void { pausedUntil = 0; }
