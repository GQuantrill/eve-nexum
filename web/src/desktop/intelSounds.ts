import { alertGain, soundsMuted } from '../utils/notificationPrefs';

// The intel alert sounds the pilot picks from in the desktop app's settings
// (intelSoundName). All made with Web Audio, no files. The ids are shared with
// the app (desktop/src-tauri/src/settings.rs, INTEL_SOUNDS); an id this page
// doesn't know (a newer app) plays the default.

export const INTEL_SOUNDS = ['twoTone', 'chime', 'ping', 'bell', 'blip', 'alarm', 'low'] as const;
export type IntelSoundName = (typeof INTEL_SOUNDS)[number];
export const DEFAULT_INTEL_SOUND: IntelSoundName = 'twoTone';

interface Note {
  /** Seconds after the start. */
  at: number;
  freq: number;
  /** Seconds until it has faded out. */
  len: number;
  type?: OscillatorType;
  /** Relative loudness, 1 = the base level. */
  vol?: number;
}

const BASE = 0.25;

const SOUNDS: Record<IntelSoundName, Note[]> = {
  // Two short low-high tones: the original intel sound.
  twoTone: [
    { at: 0, freq: 660, len: 0.15 },
    { at: 0.18, freq: 990, len: 0.15 },
  ],
  // Three falling notes, soft.
  chime: [
    { at: 0, freq: 1318.5, len: 0.35 },
    { at: 0.14, freq: 1046.5, len: 0.35 },
    { at: 0.28, freq: 880, len: 0.6 },
  ],
  // One high note with a long tail, like sonar.
  ping: [{ at: 0, freq: 1480, len: 0.9 }],
  // A struck bell: the note plus its bright overtone.
  bell: [
    { at: 0, freq: 784, len: 1.2 },
    { at: 0, freq: 784 * 2.76, len: 0.5, vol: 0.35 },
  ],
  // Two quick high blips.
  blip: [
    { at: 0, freq: 1200, len: 0.07, type: 'triangle' },
    { at: 0.1, freq: 1200, len: 0.07, type: 'triangle' },
  ],
  // An urgent repeated two-note alarm.
  alarm: [
    { at: 0, freq: 880, len: 0.12, type: 'square', vol: 0.5 },
    { at: 0.14, freq: 660, len: 0.12, type: 'square', vol: 0.5 },
    { at: 0.28, freq: 880, len: 0.12, type: 'square', vol: 0.5 },
    { at: 0.42, freq: 660, len: 0.12, type: 'square', vol: 0.5 },
  ],
  // Two low falling tones: noticeable without being shrill.
  low: [
    { at: 0, freq: 330, len: 0.25, type: 'triangle', vol: 1.4 },
    { at: 0.26, freq: 247, len: 0.4, type: 'triangle', vol: 1.4 },
  ],
};

export function isIntelSound(name: unknown): name is IntelSoundName {
  return typeof name === 'string' && (INTEL_SOUNDS as readonly string[]).includes(name);
}

let audioCtx: AudioContext | null = null;

/** Play an intel sound (the default for an unknown name), at the site's
 *  alert volume. */
export function playIntelSound(name?: string | null): void {
  if (soundsMuted()) return;
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    const ctx = audioCtx;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    const notes = SOUNDS[isIntelSound(name) ? name : DEFAULT_INTEL_SOUND];
    for (const n of notes) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = n.type ?? 'sine';
      o.frequency.value = n.freq;
      const t = ctx.currentTime + n.at;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, alertGain(BASE * (n.vol ?? 1))), t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + n.len);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(t);
      o.stop(t + n.len + 0.02);
    }
  } catch { /* audio blocked or unavailable */ }
}
