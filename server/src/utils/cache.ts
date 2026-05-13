// Two small TTL cache primitives used by routes that proxy ESI / zKillboard.
//
// - TtlValue<V>: a single TTL-guarded slot with last-success fallback. Used by
//   /api/incursions and /api/insurgency, which fetch one global blob.
// - TtlCache<K, V>: a per-key TTL cache. Used by /api/killboard which caches
//   per system id, and may grow large enough that we sweep expired entries
//   on a schedule.

export class TtlValue<V> {
  private value: V | null = null;
  private fetchedAt = 0;

  constructor(private ttlMs: number) {}

  get(): V | null {
    if (this.value !== null && Date.now() - this.fetchedAt < this.ttlMs) return this.value;
    return null;
  }

  // Returns the cached value even if it's stale — useful as a fallback when
  // a refresh fails.
  getStale(): V | null { return this.value; }

  set(v: V): void {
    this.value = v;
    this.fetchedAt = Date.now();
  }
}

export interface TtlEntry<V> {
  value:     V;
  fetchedAt: number;
  meta?:     Record<string, unknown>;
}

export class TtlCache<K, V> {
  private store = new Map<K, TtlEntry<V>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private ttlMs: number, sweepIntervalMs?: number) {
    if (sweepIntervalMs) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
      // Keep the process from hanging on the timer in CLI tools / tests.
      if (typeof this.sweepTimer === 'object' && 'unref' in this.sweepTimer) {
        (this.sweepTimer as { unref: () => void }).unref();
      }
    }
  }

  get(key: K): TtlEntry<V> | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt >= this.ttlMs) return null;
    return entry;
  }

  // Returns the entry regardless of TTL — for fallback paths when a refresh
  // fails and we'd rather serve stale data than an error.
  peek(key: K): TtlEntry<V> | null {
    return this.store.get(key) ?? null;
  }

  set(key: K, value: V, meta?: Record<string, unknown>): void {
    this.store.set(key, { value, fetchedAt: Date.now(), meta });
  }

  delete(key: K): void { this.store.delete(key); }

  // Evict entries older than 2× TTL. Called automatically when a sweep
  // interval is configured.
  sweep(): void {
    const cutoff = Date.now() - this.ttlMs * 2;
    for (const [k, entry] of this.store) {
      if (entry.fetchedAt < cutoff) this.store.delete(k);
    }
  }
}
