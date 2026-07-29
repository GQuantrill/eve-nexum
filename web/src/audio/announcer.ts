import { create } from 'zustand';
import type { KokoroTTS } from 'kokoro-js';

// PROTOTYPE in-browser voice announcer using Kokoro-82M (kokoro-js + ONNX).
// Runs entirely client-side: the model is lazy-loaded from the Hugging Face hub
// the first time the user enables voice (behind a user gesture, so autoplay is
// satisfied), then generation + playback happen locally — no server, no per-use
// cost, works offline once cached.
//
// KNOWN ROUGH EDGES (fine for evaluating quality/latency, to fix before shipping):
//  - Generation runs on the MAIN THREAD, so a long phrase briefly janks the UI.
//    The real version should run Kokoro in a Web Worker.
//  - First load downloads the model (tens–hundreds of MB depending on dtype).
//  - WebGPU path is fastest (Chrome/Edge); falls back to WASM (CPU) elsewhere.

type Status = 'idle' | 'loading' | 'ready' | 'error';

interface ProgressInfo { status?: string; progress?: number; file?: string }

interface AnnouncerState {
  status:   Status;
  progress: number;        // 0..100 of the file currently downloading
  error:    string | null;
  voice:    string;
  speaking: boolean;
  setVoice: (v: string) => void;
  load:     () => Promise<void>;
  speak:    (text: string) => Promise<void>;
  stop:     () => void;
}

// A small curated set of Kokoro v1.0 voices (there are ~50). id -> display label.
export const VOICES: Array<{ id: string; label: string }> = [
  { id: 'af_heart',   label: 'Heart (US, female)' },
  { id: 'af_bella',   label: 'Bella (US, female)' },
  { id: 'af_nicole',  label: 'Nicole (US, female)' },
  { id: 'am_michael', label: 'Michael (US, male)' },
  { id: 'am_fenrir',  label: 'Fenrir (US, male)' },
  { id: 'bf_emma',    label: 'Emma (UK, female)' },
  { id: 'bm_george',  label: 'George (UK, male)' },
];

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// Kokoro types `voice` as a union of its known ids; ours is a plain string from
// the store, so narrow to that union at the call site (every VOICES id is valid).
type VoiceId = NonNullable<Parameters<KokoroTTS['generate']>[1]>['voice'];

// The model + generation queue live outside the store (non-serialisable, and we
// never want React to try to diff them).
let tts: KokoroTTS | null = null;
let loadPromise: Promise<void> | null = null;
let queue: Promise<void> = Promise.resolve();
let current: HTMLAudioElement | null = null;

export const useAnnouncer = create<AnnouncerState>((set, get) => ({
  status: 'idle',
  progress: 0,
  error: null,
  voice: 'af_heart',
  speaking: false,

  setVoice: (v) => set({ voice: v }),

  load: async () => {
    if (get().status === 'ready') return;
    if (loadPromise) return loadPromise;
    set({ status: 'loading', progress: 0, error: null });
    loadPromise = (async () => {
      // Configure the ONNX runtime (transformers.js backend) BEFORE loading:
      // force single-threaded wasm so it doesn't need SharedArrayBuffer /
      // cross-origin isolation (we deliberately don't set COOP/COEP — those
      // would break cross-origin images/GTM). The ORT runtime .mjs/.wasm load
      // from jsdelivr, which the demo CSP allows in script-src + connect-src.
      try {
        const { env } = await import('@huggingface/transformers');
        (env.backends.onnx.wasm as { numThreads?: number }).numThreads = 1;
      } catch { /* best-effort — proceed with defaults */ }

      const { KokoroTTS: Kokoro } = await import('kokoro-js');
      const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
      tts = await Kokoro.from_pretrained(MODEL_ID, {
        device: webgpu ? 'webgpu' : 'wasm',
        // fp32 on WebGPU for best quality; q8 keeps the WASM/CPU path small+quick.
        dtype: webgpu ? 'fp32' : 'q8',
        progress_callback: (p: ProgressInfo) => {
          if (typeof p.progress === 'number') set({ progress: Math.round(p.progress) });
        },
      });
      set({ status: 'ready', progress: 100 });
    })().catch((e: unknown) => {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      loadPromise = null;
      throw e;
    });
    return loadPromise;
  },

  speak: async (text) => {
    const clean = text.trim().replace(/\s+/g, ' ').slice(0, 300);   // cap length
    if (!clean) return;
    if (get().status !== 'ready') { try { await get().load(); } catch { return; } }
    const voice = get().voice;
    // Serialise generations so announcements don't overlap or race the model.
    queue = queue.then(async () => {
      if (!tts) return;
      set({ speaking: true });
      try {
        const audio = await tts.generate(clean, { voice: voice as VoiceId });
        const url = URL.createObjectURL(audio.toBlob());
        await new Promise<void>((resolve) => {
          const el = new Audio(url);
          current = el;
          const done = () => { URL.revokeObjectURL(url); if (current === el) current = null; resolve(); };
          el.onended = done;
          el.onerror = done;
          void el.play().catch(done);
        });
      } catch {
        /* prototype: swallow generation/playback failures */
      } finally {
        set({ speaking: false });
      }
    });
    return queue;
  },

  stop: () => {
    if (current) { current.pause(); current = null; }
    queue = Promise.resolve();
    set({ speaking: false });
  },
}));
