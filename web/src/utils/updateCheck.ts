import i18n from '../i18n';
import { toast } from './toastStore';

// "A new version is available": tabs and installed-app windows stay open for
// days, running whatever build they loaded. Each build publishes its id as
// /version.json (see vite.config.ts); when that stops matching the id baked
// into this page, offer a reload. Never reloads by itself -- that could throw
// away a half-typed note or a scan mid-paste.

const CHECK_MS = 10 * 60_000;

let offered = false;

async function check(): Promise<void> {
  if (offered || typeof __BUILD_ID__ === 'undefined') return;
  let build: unknown;
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return;
    build = ((await res.json()) as { build?: unknown }).build;
  } catch {
    return; // offline, or the dev server answering with HTML
  }
  if (typeof build !== 'string' || build === __BUILD_ID__) return;
  offered = true;
  toast.show(i18n.t('update.available'), {
    kind: 'info', sticky: true, dedupeKey: 'app-update',
    actions: [{ label: i18n.t('update.reload'), onClick: () => window.location.reload() }],
  });
}

export function startUpdateCheck(): void {
  setInterval(() => { void check(); }, CHECK_MS);
  // Coming back to the tab is the natural moment: the pilot is looking.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
}
