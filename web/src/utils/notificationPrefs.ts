import { readUserSetting } from '../hooks/useUserSetting';

// Per-event notification preferences. Each alertable event has two independent
// channels — a desktop (browser) notification and a sound — that the user
// toggles in the sidebar's Notifications section. Stored in the cross-device
// ui_settings JSONB via useUserSetting; read here (sync) at fire time so the
// plain alert utilities don't need to be hooks.
//
// watchlistSound deliberately reuses the pre-existing 'nexum.watchlist.sound'
// key so existing users keep their setting.
export const NOTIFY = {
  k162Desktop:      'nexum.notify.k162.desktop',
  k162Sound:        'nexum.notify.k162.sound',
  proximityDesktop: 'nexum.notify.proximity.desktop',
  proximitySound:   'nexum.notify.proximity.sound',
  watchlistDesktop: 'nexum.notify.watchlist.desktop',
  watchlistSound:   'nexum.watchlist.sound',
} as const;

// Defaults preserve today's behaviour: K162 and proximity alert on both
// channels; the watchlist keeps its sound but desktop is opt-in (it never had
// a desktop notification before).
export const NOTIFY_DEFAULTS: Record<string, boolean> = {
  [NOTIFY.k162Desktop]:      true,
  [NOTIFY.k162Sound]:        true,
  [NOTIFY.proximityDesktop]: true,
  [NOTIFY.proximitySound]:   true,
  [NOTIFY.watchlistDesktop]: false,
  [NOTIFY.watchlistSound]:   true,
};

/** Whether a given notification channel is enabled (sync read at fire time). */
export function notifyOn(key: string): boolean {
  return readUserSetting<boolean>(key, NOTIFY_DEFAULTS[key] ?? true);
}

/** Fire a desktop notification if the browser supports it and permission is granted. */
export function fireDesktopNotification(title: string, body: string, tag: string): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  try { new Notification(title, { body, tag }); } catch { /* ignore */ }
}
