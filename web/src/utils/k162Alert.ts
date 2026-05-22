import { toast } from '../components/ui/Toaster';

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

function fireBrowserNotification(sysName: string) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  try {
    new Notification('Inbound K162', {
      body:  `New K162 wormhole identified in ${sysName}`,
      tag:   `nexum-k162-${sysName}`,
    });
  } catch { /* ignore */ }
}

/** Fire the in-app toast, browser push, and audio ping for a newly-identified K162. */
export function alertInboundK162(sysName: string) {
  toast.info(`Inbound K162 in ${sysName}`);
  fireBrowserNotification(sysName);
  playBeep();
}
