import { createLogger } from '../utils/logger.js';

const log = createLogger('freeze');

// How often the check runs, and how late it has to fire before it counts as a
// freeze. A healthy server runs the timer within a few ms of schedule.
const TICK_MS   = 500;
const FREEZE_MS = 1_000;

/**
 * Returns a tick function that logs when it runs FREEZE_MS or more later than
 * TICK_MS after the previous tick: the server was busy and answered nobody
 * for that long. Exported separately so tests can drive the clock.
 */
export function freezeCheck(now: () => number = () => performance.now()): () => void {
  let last = now();
  return () => {
    const t = now();
    const late = Math.round(t - last - TICK_MS);
    last = t;
    if (late >= FREEZE_MS) {
      const heapMb = Math.round(process.memoryUsage().heapUsed / 1_048_576);
      log.warn(`server froze for ${late}ms (heap ${heapMb}MB)`);
    }
  };
}

/**
 * Logs every time the server is frozen for a second or more, for example by a
 * long synchronous job or garbage collection. Waiting on the database or ESI
 * doesn't freeze it. Added to explain the map-switch hangs: together with the
 * [slow] request log it shows whether a stall was inside nexum.
 */
export function startFreezeDetector(): void {
  setInterval(freezeCheck(), TICK_MS).unref();
}
