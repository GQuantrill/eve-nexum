import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A stand-in worker that runs the real timerWorker protocol on the test's timers.
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<{ id: number }>) => void) | null = null;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  constructor() { FakeWorker.instances.push(this); }
  postMessage({ id, ms }: { id: number; ms: number }): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    if (ms < 0) return;
    this.timers.set(id, setTimeout(() => this.onmessage?.({ data: { id } } as MessageEvent<{ id: number }>), ms));
  }
}

async function load() {
  vi.resetModules();
  return import('./workerTimer');
}

describe('workerTimer', () => {
  beforeEach(() => { vi.useFakeTimers(); FakeWorker.instances = []; });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('runs each callback once, through a single worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const { setWorkerTimeout } = await load();
    const a = vi.fn(), b = vi.fn();
    setWorkerTimeout(a, 100);
    setWorkerTimeout(b, 200);
    vi.advanceTimersByTime(150);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(b).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('cancels', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const { setWorkerTimeout, clearWorkerTimeout } = await load();
    const fn = vi.fn();
    clearWorkerTimeout(setWorkerTimeout(fn, 100));
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
  });

  it('falls back to setTimeout when a worker cannot start', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('blocked'); } });
    const { setWorkerTimeout, clearWorkerTimeout } = await load();
    const fn = vi.fn(), never = vi.fn();
    setWorkerTimeout(fn, 100);
    clearWorkerTimeout(setWorkerTimeout(never, 100));
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(never).not.toHaveBeenCalled();
  });
});
