interface LogEntry {
  ts: string;
  level: 'error' | 'warn' | 'api';
  message: string;
  detail?: unknown;
}

const MAX_ENTRIES = 500;
const log: LogEntry[] = [];

function entry(level: LogEntry['level'], message: string, detail?: unknown) {
  log.push({ ts: new Date().toISOString(), level, message, detail });
  if (log.length > MAX_ENTRIES) log.shift();
}

// Capture console.error and console.warn
const _error = console.error.bind(console);
const _warn  = console.warn.bind(console);

console.error = (...args: unknown[]) => {
  entry('error', args.map(String).join(' '), args.length > 1 ? args : undefined);
  _error(...args);
};

console.warn = (...args: unknown[]) => {
  entry('warn', args.map(String).join(' '), args.length > 1 ? args : undefined);
  _warn(...args);
};

// Intercept fetch to log API failures
const _fetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
  const res = await _fetch(input, init);
  if (!res.ok && url.includes('/api/')) {
    entry('api', `${res.status} ${res.statusText} — ${url}`);
  }
  return res;
};

// Expose debug helpers on window
const nexumDebug = {
  dump() {
    if (log.length === 0) { console.log('[nexum] No entries captured.'); return; }
    console.group(`[nexum] Debug log (${log.length} entries)`);
    for (const e of log) {
      const fn = e.level === 'error' ? console.error : e.level === 'warn' ? console.warn : console.info;
      fn(`[${e.ts}] [${e.level.toUpperCase()}] ${e.message}`, ...(e.detail != null ? [e.detail] : []));
    }
    console.groupEnd();
  },

  errors() {
    const errs = log.filter((e) => e.level === 'error');
    if (errs.length === 0) { console.log('[nexum] No errors captured.'); return; }
    console.group(`[nexum] Errors (${errs.length})`);
    for (const e of errs) console.error(`[${e.ts}] ${e.message}`, ...(e.detail != null ? [e.detail] : []));
    console.groupEnd();
  },

  api() {
    const calls = log.filter((e) => e.level === 'api');
    if (calls.length === 0) { console.log('[nexum] No failed API calls captured.'); return; }
    console.group(`[nexum] Failed API calls (${calls.length})`);
    for (const e of calls) console.warn(`[${e.ts}] ${e.message}`);
    console.groupEnd();
  },

  queue() {
    import('./store/pendingQueue').then(({ getQueue }) => {
      const q = getQueue();
      if (q.length === 0) { console.log('[nexum] Pending queue is empty.'); return; }
      console.group(`[nexum] Pending queue (${q.length} ops)`);
      for (const op of q) console.warn(`  [attempt ${op.attempts}] ${op.method} ${op.url} — ${op.label}`);
      console.groupEnd();
    });
  },

  flush() {
    import('./store/pendingQueue').then(({ flushQueue }) => {
      console.log('[nexum] Manually flushing queue...');
      flushQueue();
    });
  },

  mapState() {
    // Dynamically import to avoid circular deps at init time
    import('./store/mapStore').then(({ useMapStore }) => {
      const state = useMapStore.getState();
      console.group('[nexum] Map store state');
      console.log('Map ID:', state.map.id);
      console.log('Systems:', state.map.systems.length, state.map.systems.map((s) => `${s.name} (${s.id})`));
      console.log('Connections:', state.map.connections.length);
      console.log('Active map ID:', state.activeMapId);
      console.groupEnd();
    });
  },

  // ── Jump simulator ──────────────────────────────────────────────────────
  // Replays a player route through the active map, one hop every `intervalMs`,
  // driving the SAME applyJump() code path as live location tracking so node
  // placement / connection behaviour matches a real jump. Use it to reproduce
  // positioning bugs (e.g. jumping in and out of the same system).
  //   nexumDebug.simulateJumps(['Jita', 'Perimeter', 'Jita', 'New Caldari'])
  //   nexumDebug.simulateJumps(['Jita', 'Perimeter'], 1000, { dryRun: true })
  //   nexumDebug.stopJumps()
  // Names are EVE system names / J-codes; each is resolved via the systems API.
  // NOTE: this mutates the active map for real (adds systems + connections).
  // Pass { dryRun: true } to exercise placement locally without firing (or
  // queuing) any server writes — useful when logged out or without a saved map.
  _jumpTimer: null as ReturnType<typeof setInterval> | null,

  async simulateJumps(names: string[], intervalMs = 2000, opts: { dryRun?: boolean } = {}) {
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
      console.error('[nexum] simulateJumps(names[], intervalMs?, { dryRun? }) — names must be an array of system names.');
      return;
    }
    const { dryRun = false } = opts;
    const [{ applyJump }, store, esi, client] = await Promise.all([
      import('./hooks/useLocationTracking'),
      import('./store/mapStore'),
      import('./hooks/useEsiSearch'),
      import('./api/client'),
    ]);
    const { useMapStore } = store;

    const resolve = async (name: string) => {
      const results = await (await fetch(
        `${(await import('./api/client')).apiUrl(`/api/systems/search?q=${encodeURIComponent(name)}`)}`,
        { credentials: 'include' },
      )).json() as Array<{ id: number; name: string }>;
      const hit = results.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? results[0];
      if (!hit) return null;
      const d = await esi.fetchSystemDetail(hit.id);
      return {
        eveSystemId: d.id, name: d.name, systemClass: d.systemClass, effect: d.effect,
        statics: d.statics ?? [], regionName: d.regionName ?? null, npcType: d.npcType ?? null,
      };
    };

    if (this._jumpTimer) { clearInterval(this._jumpTimer); this._jumpTimer = null; }
    let prev = useMapStore.getState().currentSystemId;
    let i = 0;
    console.log(`[nexum] Simulating ${names.length} jumps, one every ${intervalMs}ms${dryRun ? ' (dry run — no server writes)' : ''}. nexumDebug.stopJumps() to cancel.`);

    const step = async () => {
      if (i >= names.length) { this.stopJumps(); console.log('[nexum] Jump simulation complete.'); return; }
      const name = names[i++];
      const sys = await resolve(name);
      if (!sys) { console.warn(`[nexum] Could not resolve "${name}" — skipping.`); return; }
      // applyJump's writes are dispatched synchronously (the suppression check
      // runs before fetch), so toggling around this call captures them all.
      if (dryRun) client.setWritesSuppressed(true);
      let id: string | null;
      try {
        id = applyJump(sys, prev, true);
      } finally {
        if (dryRun) client.setWritesSuppressed(false);
      }
      if (id) {
        prev = id;
        useMapStore.getState().setCurrentSystem(id);
        useMapStore.getState().selectSystem(id);
        const pos = useMapStore.getState().map.systems.find((s) => s.id === id)?.position;
        console.log(`[nexum] jump ${i}/${names.length} → ${sys.name}  @ (${pos?.x}, ${pos?.y})`);
      }
    };
    await step();
    this._jumpTimer = setInterval(() => { void step(); }, intervalMs);
  },

  stopJumps() {
    if (this._jumpTimer) { clearInterval(this._jumpTimer); this._jumpTimer = null; console.log('[nexum] Jump simulation stopped.'); }
    else console.log('[nexum] No jump simulation running.');
  },

  clear() {
    log.length = 0;
    console.log('[nexum] Debug log cleared.');
  },

  help() {
    console.group('[nexum] Available commands');
    console.log('nexumDebug.dump()      — all captured log entries');
    console.log('nexumDebug.errors()    — errors only');
    console.log('nexumDebug.api()       — failed API calls only');
    console.log('nexumDebug.mapState()  — current map store snapshot');
    console.log('nexumDebug.queue()     — show pending write queue');
    console.log('nexumDebug.flush()     — manually flush the write queue');
    console.log("nexumDebug.simulateJumps(['Jita','Perimeter','Jita'], 2000) — replay a route, one hop / interval");
    console.log("nexumDebug.simulateJumps([...], 1000, { dryRun: true }) — replay without firing server writes (logged-out safe)");
    console.log('nexumDebug.stopJumps() — cancel a running jump simulation');
    console.log('nexumDebug.clear()     — clear the log buffer');
    console.groupEnd();
  },
};

(window as unknown as Record<string, unknown>).nexumDebug = nexumDebug;

console.log('[nexum] Debug logger active — type nexumDebug.help() to see available commands.');
