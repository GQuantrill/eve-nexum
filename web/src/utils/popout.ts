import { useSyncExternalStore } from 'react';
import { desktopInvoke, isDesktop, onDesktopEvent } from '../desktop/bridge';

// Pop-out panes: a sidebar pane opened in a window of its own (another
// monitor, beside the game). The window loads this same app with ?popout=<id>
// and shows only that pane (Sidebar.tsx, PopoutView); the app still loads
// the map it needs, but tracks no jumps and raises no alerts there, so
// nothing happens twice. In the desktop app it is a real app window
// (open_popout); in a browser, a popup.
//
// Which panes are out is kept in localStorage, so the main window (shows a
// "bring it back" stub instead) and the pop-out see the same list. Bringing a
// pane back closes its window.

const KEY = 'nexum.popouts';

/** The pane this window shows on its own, or null for the normal app. */
export const POPOUT_PANE: string | null = (() => {
  try {
    const id = new URLSearchParams(window.location.search).get('popout');
    return id && /^[a-zA-Z]{1,32}$/.test(id) ? id : null;
  } catch {
    return null;
  }
})();

function read(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

let current = read();
const subs = new Set<() => void>();
function write(next: string[]): void {
  current = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage off */ }
  subs.forEach((f) => f());
}
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  current = read();
  subs.forEach((f) => f());
});

/** The panes currently in windows of their own. */
export function usePoppedOut(): string[] {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => { subs.delete(cb); }; },
    () => current,
    () => current,
  );
}

// Browser popups this window opened, so "Bring back" can close them itself
// and a popup closed any way at all (even one whose page never loaded) gives
// its pane back.
const popups = new Map<string, Window>();
let watch: ReturnType<typeof setInterval> | null = null;
function watchPopups(): void {
  if (watch) return;
  watch = setInterval(() => {
    for (const [id, w] of popups) {
      if (w.closed) {
        popups.delete(id);
        if (current.includes(id)) write(current.filter((x) => x !== id));
      }
    }
    if (popups.size === 0 && watch) { clearInterval(watch); watch = null; }
  }, 1000);
}

/** In the main window: give the pane back when the app says its pop-out
 *  window closed (however it closed). */
export function startPopoutHost(): () => void {
  if (POPOUT_PANE) return () => {};
  // The app's pop-out windows close with it, so a fresh start has none: drop
  // any left listed (a crash, or the app quit with panes out).
  if (isDesktop() && current.length) write([]);
  return onDesktopEvent<string>('nexum://popout-closed', (id) => {
    if (current.includes(id)) write(current.filter((x) => x !== id));
  });
}

/** Open a pane in its own window. */
export function popOut(id: string, title: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('popout', id);
  if (isDesktop()) {
    desktopInvoke('open_popout', { pane: id, title, url: url.toString() })
      .then(() => { if (!current.includes(id)) write([...current, id]); })
      .catch(() => { /* an older app: no pop-outs */ });
    return;
  }
  const w = window.open(url.toString(), `nexum-popout-${id}`, 'popup,width=420,height=680');
  if (!w) return;
  popups.set(id, w);
  watchPopups();
  if (!current.includes(id)) write([...current, id]);
}

/** Put a pane back in the sidebar (and close its window). */
export function bringBack(id: string): void {
  write(current.filter((x) => x !== id));
  if (isDesktop()) void desktopInvoke('close_popout', { pane: id }).catch(() => {});
  const w = popups.get(id);
  popups.delete(id);
  try { w?.close(); } catch { /* already gone */ }
}

/** In a pop-out window: when its pane is brought back from the main window,
 *  close; when this window closes, give the pane back. */
export function startPopoutWindow(): () => void {
  if (!POPOUT_PANE) return () => {};
  const id = POPOUT_PANE;
  // Listed while open (again, after a reload of this window).
  if (!current.includes(id)) write([...current, id]);
  const onChange = () => {
    if (!current.includes(id)) {
      if (isDesktop()) void desktopInvoke('close_popout', { pane: id }).catch(() => {});
      else window.close();
    }
  };
  subs.add(onChange);
  const onLeave = () => { if (current.includes(id)) write(current.filter((x) => x !== id)); };
  window.addEventListener('pagehide', onLeave);
  return () => { subs.delete(onChange); window.removeEventListener('pagehide', onLeave); };
}
