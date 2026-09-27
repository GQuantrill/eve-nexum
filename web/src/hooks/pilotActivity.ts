// Is the acting character actually logged into EVE right now?
//
// Polling cadences are tuned for someone flying: the location poll runs every
// 10s so a jump is noticed quickly. But a tab left open with the pilot logged
// OUT pays that same rate for data that cannot change — a character who isn't
// in game does not move, does not join fleets, and does not undock. Overnight
// that is thousands of requests returning the same answer.
//
// Tab visibility is the wrong signal for this app: an EVE mapper normally sits
// behind the game client, so "hidden" is the working state, not the idle one
// (see useCharacterLocation's own note). Whether the pilot is in game is the
// honest signal, and it costs nothing to obtain — the location poll already
// reports it on every tick.
//
// `null` means not yet known. Callers back off only on a definite `false`, so
// a startup tick or a failed request never slows anything down.

let online: boolean | null = null;
const listeners = new Set<() => void>();

/** Record what the latest location poll said. Called by useCharacterLocation. */
export function setPilotOnline(next: boolean | null): void {
  if (next === online) return;
  online = next;
  listeners.forEach((fn) => fn());
}

/** True only when we KNOW the pilot is logged out — never on unknown. */
export function pilotIsOffline(): boolean {
  return online === false;
}

/** Current value, for UI that wants to explain why a poll has slowed. */
export function pilotOnline(): boolean | null {
  return online;
}

/** Notified whenever the pilot's in-game presence flips, so a poller can
 *  reschedule immediately rather than waiting out its slow interval. */
export function subscribePilotActivity(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Test seam — resets the module between cases. */
export function _resetPilotActivityForTests(): void {
  online = null;
  listeners.clear();
}
