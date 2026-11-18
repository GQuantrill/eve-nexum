// The bridge to the Nexum desktop app (desktop/, Tauri). The same web app runs
// in a browser and inside the desktop window; only the desktop window has the
// Tauri globals, so everything here is a no-op on the web. Nothing in the app
// may depend on the desktop being there -- each feature checks isDesktop().

interface TauriGlobal {
  core:  { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
  event: { listen: <T>(event: string, cb: (e: { payload: T }) => void) => Promise<() => void> };
}

function tauri(): TauriGlobal | null {
  const t = (window as unknown as { __TAURI__?: Partial<TauriGlobal> }).__TAURI__;
  return t?.core && t?.event ? (t as TauriGlobal) : null;
}

/** True inside the Nexum desktop app, false in a browser. */
export function isDesktop(): boolean {
  return tauri() !== null;
}

/** Call a desktop command. Rejects on the web. */
export function desktopInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = tauri();
  return t ? t.core.invoke<T>(cmd, args) : Promise.reject(new Error('not desktop'));
}

/** Listen to a desktop event. Returns an unsubscribe; a no-op on the web. */
export function onDesktopEvent<T>(event: string, cb: (payload: T) => void): () => void {
  const t = tauri();
  if (!t) return () => {};
  let off: (() => void) | null = null;
  let cancelled = false;
  void t.event.listen<T>(event, (e) => cb(e.payload)).then((u) => {
    if (cancelled) u(); else off = u;
  });
  return () => { cancelled = true; off?.(); };
}

/**
 * Show a system notification through the desktop app (a remote page inside
 * the app's webview can't use the browser Notification API). Returns false
 * on the web, so callers fall back to the browser path.
 */
export function desktopNotify(title: string, body: string): boolean {
  if (!isDesktop()) return false;
  void desktopInvoke('notify', { title, body }).catch(() => {});
  return true;
}
