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

/**
 * Alert volume, 0–100. Nexum's chimes are generated rather than played from a
 * file, so their loudness is a gain value in code — there was no way to turn
 * them down, and macOS has no per-app volume to fall back on.
 */
export const ALERT_VOLUME_KEY = 'nexum.notify.volume';
export const ALERT_VOLUME_DEFAULT = 100;

/**
 * Scale a chime's peak gain by the user's volume. Each alert keeps its own
 * relative loudness (they're deliberately different, so the ear can tell them
 * apart) — this just moves them all together.
 */
export function alertGain(peak: number): number {
  const pct = readUserSetting<number>(ALERT_VOLUME_KEY, ALERT_VOLUME_DEFAULT);
  const clamped = Math.min(100, Math.max(0, Number(pct) || 0));
  // Perceived loudness is closer to the square of amplitude than to amplitude,
  // so square the fraction — a 50% slider then sounds about half as loud.
  const scale = (clamped / 100) ** 2;
  // Web Audio's exponential ramps can't reach 0, so floor at something
  // inaudible rather than silent. Muting is the channel toggle's job.
  return Math.max(peak * scale, 0.00001);
}

/**
 * Play a short sample at the current volume, so the slider can be set by ear.
 * Deliberately the proximity tone (the loudest of the four) — set that
 * comfortably and nothing else will startle you.
 */
export function previewAlertVolume(): void {
  try {
    const Ctx = window.AudioContext
      ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    o.type = 'sine';
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(alertGain(0.25), ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.34);
    setTimeout(() => void ctx.close(), 600);
  } catch { /* audio blocked / unavailable — silent fail */ }
}

/** Lowest security that counts as an exit worth alerting on. */
export const EXITS_MIN_SECURITY_KEY = 'nexum.notify.exitsMinSecurity';
export const EXITS_MIN_SECURITY_DEFAULT = 0.45;
/**
 * "Never alert" — above the 1.0 ceiling, so no system can ever meet it and the
 * alert simply has nothing to fire on. Unticking both channels silences it too,
 * but that's a thing you have to know; an explicit Off in the same dropdown you
 * used to switch it on is where people look for it.
 */
export const EXITS_MIN_SECURITY_OFF = 2;

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
