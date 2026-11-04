import { useSyncExternalStore } from 'react';

// "Install as app" (Chromium: Chrome, Edge, Brave...). The browser fires
// beforeinstallprompt once, early in page load, when the site is installable
// (it has a manifest -- web/public/manifest.webmanifest) and isn't installed.
// We hold on to it so a menu item can open the install dialog later. Imported
// from main.tsx so the listener exists before that event fires. Other browsers
// never fire it, so the menu item simply never shows there.

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Keep it for our own button. The browser's own install icon in the
    // address bar stays available either way.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

/** True while the browser will let us offer an install. */
export function useCanInstallApp(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => deferred !== null,
    () => false,
  );
}

/** Open the browser's install dialog. A prompt can only be used once. */
export async function installApp(): Promise<void> {
  const e = deferred;
  if (!e) return;
  deferred = null;
  notify();
  await e.prompt();
  // Dismissed: Chromium fires beforeinstallprompt again later, which brings
  // the menu item back.
  await e.userChoice.catch(() => undefined);
}
