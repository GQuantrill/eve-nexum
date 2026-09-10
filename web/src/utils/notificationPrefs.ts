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
  exitsDesktop:     'nexum.notify.exits.desktop',
  exitsSound:       'nexum.notify.exits.sound',
} as const;

/** Lowest security that counts as an exit worth alerting on. */
export const EXITS_MIN_SECURITY_KEY = 'nexum.notify.exitsMinSecurity';
export const EXITS_MIN_SECURITY_DEFAULT = 0.45;

// Proximity alerts on both channels and the watchlist keeps its sound (desktop
// there was always opt-in). K162 and exits are opt-in: both are chain-wide
// chatter rather than something happening to you, and on a busy chain they fire
// constantly, so they stay quiet until asked for.
export const NOTIFY_DEFAULTS: Record<string, boolean> = {
  [NOTIFY.k162Desktop]:      false,
  [NOTIFY.k162Sound]:        false,
  [NOTIFY.proximityDesktop]: true,
  [NOTIFY.proximitySound]:   true,
  [NOTIFY.watchlistDesktop]: false,
  [NOTIFY.watchlistSound]:   true,
  [NOTIFY.exitsDesktop]:     false,
  [NOTIFY.exitsSound]:       false,
};

/**
 * Whether an alert should fire at all. For the opt-in alerts both channels off
 * means silence — including the in-app toast, which otherwise shows regardless
 * and would leave the feature only half-off.
 */
export function anyChannelOn(desktopKey: string, soundKey: string): boolean {
  return notifyOn(desktopKey) || notifyOn(soundKey);
}

/** A channel's shipped default, for UI that has to render before any choice. */
export function notifyDefault(key: string): boolean {
  return NOTIFY_DEFAULTS[key] ?? true;
}

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
