import { toast } from '../components/ui/Toaster';
import { NOTIFY, notifyOn, fireDesktopNotification } from './notificationPrefs';

// Audio context is created lazily on first use to avoid autoplay-policy issues.
let audioCtx: AudioContext | null = null;
function playBeep() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ctx = audioCtx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    // Higher pitch + sawtooth gives the K162 alert a distinct ring from the
    // proximity-alert beep (which uses 880Hz sine).
    o.frequency.value = 1320;
    o.type = 'sawtooth';
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.3);
  } catch { /* audio blocked / unavailable — silent fail */ }
}

/**
 * Fire the in-app toast, plus the browser push and audio ping for a
 * newly-identified K162 — the latter two only if the user has those channels
 * enabled (Notifications section in the sidebar). The toast is in-app feedback
 * and always shows.
 */
export function alertInboundK162(sysName: string) {
  toast.info(`Inbound K162 in ${sysName}`);
  if (notifyOn(NOTIFY.k162Desktop)) {
    fireDesktopNotification('Inbound K162', `New K162 wormhole identified in ${sysName}`, `nexum-k162-${sysName}`);
  }
  if (notifyOn(NOTIFY.k162Sound)) playBeep();
}
