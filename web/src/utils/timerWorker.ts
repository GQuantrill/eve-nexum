// Runs inside a dedicated worker; see workerTimer.ts for why.
// In: { id, ms } to arm a one-shot timer, { id, ms: -1 } to cancel it.
// Out: { id } when it fires.

const timers = new Map<number, ReturnType<typeof setTimeout>>();

self.onmessage = (e: MessageEvent<{ id: number; ms: number }>) => {
  const { id, ms } = e.data;
  const old = timers.get(id);
  if (old !== undefined) { clearTimeout(old); timers.delete(id); }
  if (ms < 0) return;
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    self.postMessage({ id });
  }, ms));
};
