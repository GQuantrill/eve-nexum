import { api } from '../api/client';

interface PendingOp {
  id: string;
  label: string;
  url: string;
  method: string;
  body: string;
  attempts: number;
}

const MAX_ATTEMPTS = 5;
const queue: PendingOp[] = [];
let flushing = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function opId() {
  return Math.random().toString(36).slice(2, 9);
}

// Retry the queue on our own shortly after a write is enqueued, rather than only
// when the 10s location poll happens to flush it — and never at all when nothing
// polls (the jump simulator, or a stationary/logged-out session). The short
// delay lets an in-flight dependency land first: the common case is a connection
// POST that 409'd because its endpoint system's POST hadn't committed yet, so a
// ~0.6s retry succeeds instead of the link sitting broken until the next poll.
function scheduleFlush(delayMs = 600): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; void flushQueue(); }, delayMs);
}

export function enqueue(label: string, url: string, method: string, body: string) {
  queue.push({ id: opId(), label, url, method, body, attempts: 0 });
  console.warn(`[queue] Enqueued (${queue.length} pending): ${label}`);
  scheduleFlush();
}

export async function flushQueue(): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;

  const snapshot = [...queue];
  queue.length = 0;

  for (const op of snapshot) {
    try {
      await api(op.url, { method: op.method, body: op.body });
      console.log(`[queue] Flushed: ${op.label}`);
    } catch {
      op.attempts += 1;
      if (op.attempts < MAX_ATTEMPTS) {
        queue.push(op);
        console.warn(`[queue] Re-queued (attempt ${op.attempts}/${MAX_ATTEMPTS}): ${op.label}`);
      } else {
        console.error(`[queue] Dropped after ${MAX_ATTEMPTS} attempts: ${op.label}`);
      }
    }
  }

  flushing = false;

  // Anything still queued after a failed pass: retry with a backoff that grows
  // with the worst attempt count, so a dependency that's slow to appear gets
  // time to land without the queue spinning.
  if (queue.length > 0) {
    const worst = Math.max(...queue.map((op) => op.attempts));
    scheduleFlush(Math.min(8000, 600 * 2 ** worst));
  }
}

export function getQueue(): PendingOp[] {
  return [...queue];
}

export function clearQueue(): void {
  queue.length = 0;
}
