import { create } from 'zustand';

// In-browser voice announcer (Kokoro-82M via kokoro-js + ONNX). The model and all
// generation run in a Web Worker (ttsWorker.ts) so multi-second WASM/CPU inference
// never freezes the UI; this module owns only the store, the worker plumbing, and
// audio PLAYBACK (Web Audio must live on the main thread). Self-hosting + the voice
// cache-prime are handled inside the worker. Model loads lazily on the first
// load()/speak(); playback is unlocked by the first user gesture.

type Status = 'idle' | 'loading' | 'ready' | 'error';

interface AnnouncerState {
  status:   Status;
  progress: number;        // 0..100 of the file currently downloading
  error:    string | null;
  voice:    string;
  speaking: boolean;
  backend:  string;        // which ONNX backend/dtype actually ran (diagnostic)
  setVoice: (v: string) => void;
  load:     () => Promise<void>;
  speak:    (text: string) => Promise<void>;
  stop:     () => void;
}

// Curated Kokoro v1.0 voices, quality-gated to grade C and above (kokoro-js
// exposes 28 English voices; the D/F ones have little training data and sound
// noticeably rougher, so they're left out). Grouped by country, then male /
// female, and within each group ordered best-first by Kokoro's quality grade.
export const VOICES: Array<{ id: string; label: string }> = [
  // US male
  { id: 'am_michael',  label: 'Michael (US, male)' },
  { id: 'am_fenrir',   label: 'Fenrir (US, male)' },
  { id: 'am_puck',     label: 'Puck (US, male)' },
  // US female
  { id: 'af_heart',    label: 'Heart (US, female)' },
  { id: 'af_bella',    label: 'Bella (US, female)' },
  { id: 'af_nicole',   label: 'Nicole (US, female)' },
  { id: 'af_sarah',    label: 'Sarah (US, female)' },
  { id: 'af_aoede',    label: 'Aoede (US, female)' },
  { id: 'af_kore',     label: 'Kore (US, female)' },
  { id: 'af_alloy',    label: 'Alloy (US, female)' },
  { id: 'af_nova',     label: 'Nova (US, female)' },
  // UK male
  { id: 'bm_george',   label: 'George (UK, male)' },
  { id: 'bm_fable',    label: 'Fable (UK, male)' },
  // UK female
  { id: 'bf_emma',     label: 'Emma (UK, female)' },
  { id: 'bf_isabella', label: 'Isabella (UK, female)' },
];

// ── Web Worker plumbing ───────────────────────────────────────────────────────
// The worker is created lazily (first load/speak) so its heavy deps (kokoro-js +
// transformers) aren't downloaded until the announcer is actually used.
let worker: Worker | null = null;
let loadPromise: Promise<void> | null = null;
let loadResolve: (() => void) | null = null;
let loadReject:  ((e: unknown) => void) | null = null;
let genSeq = 0;
const pendingGen = new Map<number, () => void>();   // generate id -> resolve (after playback/error)
let queue: Promise<void> = Promise.resolve();       // serialises speak() generations

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./ttsWorker.ts', import.meta.url), { type: 'module' });
  w.onmessage = async (e: MessageEvent) => {
    const m = e.data as { type: string; id?: number; progress?: number; backend?: string;
                          error?: string; samples?: Float32Array; rate?: number };
    switch (m.type) {
      case 'progress':
        useAnnouncer.setState({ progress: m.progress ?? 0 });
        break;
      case 'ready':
        useAnnouncer.setState({ status: 'ready', progress: 100, backend: m.backend ?? '' });
        loadResolve?.(); loadResolve = loadReject = null;
        break;
      case 'loadError':
        useAnnouncer.setState({ status: 'error', error: m.error ?? 'load failed' });
        loadReject?.(m.error); loadResolve = loadReject = null; loadPromise = null;
        break;
      case 'audio': {
        const done = pendingGen.get(m.id as number);
        pendingGen.delete(m.id as number);
        if (done) {                                   // undefined => cancelled by stop(); drop it
          try { await playSamples(m.samples as Float32Array, m.rate as number); } catch { /* ignore */ }
          useAnnouncer.setState({ speaking: false });
          done();
        }
        break;
      }
      case 'genError': {
        const done = pendingGen.get(m.id as number);
        pendingGen.delete(m.id as number);
        useAnnouncer.setState({ speaking: false });
        done?.();
        break;
      }
    }
  };
  w.onerror = () => {
    useAnnouncer.setState({ status: 'error', error: 'Voice worker failed to start' });
    loadReject?.('worker error'); loadResolve = loadReject = null; loadPromise = null;
  };
  worker = w;
  return w;
}

// ── Playback (main thread) ────────────────────────────────────────────────────
// Web Audio API from Kokoro's RAW Float32 samples — NOT a WAV blob through an
// <audio> element. The blob path re-encodes to 16-bit PCM (which clips/crackles on
// peaks) and lets the element resample; feeding the raw Float32 into an AudioBuffer
// at the model's own 24 kHz plays it verbatim and the browser does a clean resample
// to the device rate. One shared AudioContext, unlocked by the first user gesture.
let audioCtx: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

// Browsers start an AudioContext suspended until a user gesture. With the
// announcer on by default, prime it on the first interaction so an event that
// fires before the user has clicked anything can still play once they do.
let gestureHooked = false;
export function primeAudioOnGesture(): void {
  if (gestureHooked || typeof window === 'undefined') return;
  gestureHooked = true;
  const resume = () => { getAudioContext().resume().catch(() => { /* ignore */ }); };
  window.addEventListener('pointerdown', resume, { once: true });
  window.addEventListener('keydown', resume, { once: true });
}

async function playSamples(samples: Float32Array, sampleRate: number): Promise<void> {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* ignore */ } }
  const rate = sampleRate > 0 ? sampleRate : 24000;   // Kokoro outputs 24 kHz
  const buffer = ctx.createBuffer(1, samples.length, rate);
  buffer.getChannelData(0).set(samples);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  currentSource = source;
  await new Promise<void>((resolve) => {
    source.onended = () => { if (currentSource === source) currentSource = null; resolve(); };
    try { source.start(); } catch { resolve(); }
  });
}

export const useAnnouncer = create<AnnouncerState>((set, get) => ({
  status: 'idle',
  progress: 0,
  error: null,
  voice: 'af_nicole',
  speaking: false,
  backend: '',

  setVoice: (v) => set({ voice: v }),

  load: () => {
    if (get().status === 'ready') return Promise.resolve();
    if (loadPromise) return loadPromise;
    set({ status: 'loading', progress: 0, error: null });
    loadPromise = new Promise<void>((resolve, reject) => { loadResolve = resolve; loadReject = reject; });
    getWorker().postMessage({ type: 'load' });
    return loadPromise;
  },

  speak: async (text) => {
    const clean = text.trim().replace(/\s+/g, ' ').slice(0, 300);   // cap length
    if (!clean) return;
    if (get().status !== 'ready') { try { await get().load(); } catch { return; } }
    const voice = get().voice;
    // Serialise generations so announcements don't overlap. The worker does the
    // work; we resolve when its audio comes back and finishes playing.
    queue = queue.then(() => new Promise<void>((resolve) => {
      const id = ++genSeq;
      pendingGen.set(id, resolve);
      set({ speaking: true });
      getWorker().postMessage({ type: 'generate', id, text: clean, voice });
    }));
    return queue;
  },

  stop: () => {
    if (currentSource) { try { currentSource.stop(); } catch { /* already stopped */ } currentSource = null; }
    // Resolve any queued generations so the chain doesn't wedge; their late audio
    // (worker can't cancel mid-inference) is dropped by the 'audio' handler.
    for (const done of pendingGen.values()) done();
    pendingGen.clear();
    queue = Promise.resolve();
    set({ speaking: false });
  },
}));
