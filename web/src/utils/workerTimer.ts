// setTimeout that keeps time in a hidden tab.
//
// Chromium throttles chained timers in a tab that has been hidden for five
// minutes to one run per minute -- and a mapper is hidden whenever the pilot
// looks at another tab. A location poll on that clock misses a quick jump in and
// straight back out entirely: the pilot is home again before the next read, and
// the hole they visited never reaches the map. Timers inside a dedicated worker
// are not throttled that way, and the message that wakes the page isn't either,
// so the worker keeps the clock and the page does the work.
//
// Falls back to a plain setTimeout wherever a worker can't be started.

export type WorkerTimeout = { id: number } | { fallback: ReturnType<typeof setTimeout> };

let worker: Worker | null | undefined;
let nextId = 1;
const callbacks = new Map<number, () => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./timerWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number }>) => {
      const cb = callbacks.get(e.data.id);
      callbacks.delete(e.data.id);
      cb?.();
    };
  } catch {
    worker = null;
  }
  return worker;
}

export function setWorkerTimeout(fn: () => void, ms: number): WorkerTimeout {
  const w = getWorker();
  if (!w) return { fallback: setTimeout(fn, ms) };
  const id = nextId++;
  callbacks.set(id, fn);
  w.postMessage({ id, ms });
  return { id };
}

export function clearWorkerTimeout(h: WorkerTimeout | null): void {
  if (!h) return;
  if ('fallback' in h) { clearTimeout(h.fallback); return; }
  callbacks.delete(h.id);
  worker?.postMessage({ id: h.id, ms: -1 });
}
