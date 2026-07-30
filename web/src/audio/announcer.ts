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

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// PRODUCTION (self-hosted) vs DEV. The Docker build sets VITE_ANNOUNCER_SELF_HOSTED
// and serves the model + ORT wasm same-origin, so the CSP can stay connect-src
// 'self' with no third-party hosts. In dev (vite server, no nginx CSP) the flag is
// unset and everything loads from the Hugging Face hub / jsdelivr as normal.
const SELF_HOSTED = import.meta.env.VITE_ANNOUNCER_SELF_HOSTED === 'true';
// Weight precision. Build arg (VITE_ANNOUNCER_DTYPE); the Dockerfile downloads the
// matching onnx and passes the same value here so runtime and asset agree. q8 is
// kokoro's recommended WASM pairing (~86 MB vs 326 MB fp32); flip via the build arg.
const DTYPE = (import.meta.env.VITE_ANNOUNCER_DTYPE as string) || (SELF_HOSTED ? 'q8' : 'fp32');
// Where the self-hosted assets live (served by nginx from the built dist/).
const LOCAL_MODEL_PATH = '/models/';           // transformers: {path}{model_id}/...
const LOCAL_WASM_PATH  = '/ort/';              // ORT .wasm / .mjs
const LOCAL_VOICES_BASE = `${LOCAL_MODEL_PATH}${MODEL_ID}/voices`;

// kokoro-js fetches voice style vectors from a HARD-CODED Hugging Face URL and does
// NOT honour transformers' local-model config — BUT it first checks a CacheStorage
// bucket ("kokoro-voices") keyed by that URL, and returns the hit without any
// network. So in self-hosted mode we PRIME that cache with same-origin bytes: kokoro
// then never reaches HF and connect-src can stay 'self'. Coupled to kokoro-js's cache
// name + URL scheme, so the dep is pinned (see package.json). No-op in dev.
const KOKORO_VOICE_CACHE = 'kokoro-voices';
const hfVoiceUrl = (id: string) =>
  `https://huggingface.co/${MODEL_ID}/resolve/main/voices/${id}.bin`;
const primedVoices = new Set<string>();
async function primeVoice(id: string): Promise<void> {
  if (!SELF_HOSTED || primedVoices.has(id)) return;
  try {
    const cache = await caches.open(KOKORO_VOICE_CACHE);
    const key = hfVoiceUrl(id);
    if (!(await cache.match(key))) {
      const res = await fetch(`${LOCAL_VOICES_BASE}/${id}.bin`);   // same-origin
      if (!res.ok) return;                                          // leave unprimed → retried next call
      await cache.put(key, new Response(await res.arrayBuffer()));
    }
    primedVoices.add(id);
  } catch { /* CacheStorage unavailable — kokoro will try its own path */ }
}

// Kokoro types `voice` as a union of its known ids; ours is a plain string from
// the store, so narrow to that union at the call site (every VOICES id is valid).
type VoiceId = NonNullable<Parameters<KokoroTTS['generate']>[1]>['voice'];

// The model + generation queue live outside the store (non-serialisable, and we
// never want React to try to diff them).
let tts: KokoroTTS | null = null;
let loadPromise: Promise<void> | null = null;
let queue: Promise<void> = Promise.resolve();

// Playback via the Web Audio API from Kokoro's RAW Float32 samples — NOT a WAV
// blob through an <audio> element. The blob path re-encodes to 16-bit PCM (which
// clips/crackles on peaks) and lets the element resample; feeding the raw
// Float32 into an AudioBuffer at the model's own 24 kHz plays it verbatim and the
// browser does a clean high-quality resample to the device rate. One shared
// AudioContext, unlocked by the first user gesture (Enable/Speak).
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

  load: async () => {
    if (get().status === 'ready') return;
    if (loadPromise) return loadPromise;
    set({ status: 'loading', progress: 0, error: null });
    loadPromise = (async () => {
      // Configure the ONNX runtime (transformers.js backend) BEFORE loading.
      // Single-threaded wasm so it needs no SharedArrayBuffer / cross-origin
      // isolation (we deliberately don't set COOP/COEP — those break cross-origin
      // images/GTM). In self-hosted mode, point the runtime at same-origin assets
      // so nothing loads from a third party: the ORT .wasm from /ort/, and the
      // model (config + onnx) from /models/ with remote hub fetches disabled.
      try {
        const { env } = await import('@huggingface/transformers');
        const wasm = env.backends.onnx.wasm as { numThreads?: number; wasmPaths?: string };
        wasm.numThreads = 1;
        if (SELF_HOSTED) {
          wasm.wasmPaths = LOCAL_WASM_PATH;
          env.allowLocalModels = true;        // browser default is false — must opt in
          env.allowRemoteModels = false;      // never touch the HF hub
          env.localModelPath = LOCAL_MODEL_PATH;
          env.useBrowserCache = true;
        }
      } catch { /* best-effort — proceed with defaults */ }

      const { KokoroTTS: Kokoro } = await import('kokoro-js');
      // WASM (CPU) backend — NOT WebGPU. WebGPU produced muffled/crackling audio
      // on Chromium (AMD Dawn/D3D11 fp16 vocoder artifact); WASM/CPU sidesteps it
      // at any dtype. dtype comes from the build arg (q8 default in prod). Single-
      // threaded (numThreads=1 above) so it needs no cross-origin isolation.
      const device = 'wasm';
      const dtype  = DTYPE;
      tts = await Kokoro.from_pretrained(MODEL_ID, {
        device,
        dtype: dtype as NonNullable<Parameters<typeof Kokoro.from_pretrained>[1]>['dtype'],
        progress_callback: (p: ProgressInfo) => {
          if (typeof p.progress === 'number') set({ progress: Math.round(p.progress) });
        },
      });
      // Prime the default voice so the first announcement plays without a stall.
      await primeVoice(get().voice);
      set({ status: 'ready', progress: 100, backend: `${device}/${dtype}${SELF_HOSTED ? '/self-hosted' : ''}` });
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
        await primeVoice(voice);   // ensure the voice is same-origin-cached first
        const audio = await tts.generate(clean, { voice: voice as VoiceId });
        // RawAudio: .audio is the Float32 waveform, .sampling_rate is 24000.
        await playSamples(audio.audio as Float32Array, audio.sampling_rate);
      } catch {
        /* prototype: swallow generation/playback failures */
      } finally {
        set({ speaking: false });
      }
    });
    return queue;
  },

  stop: () => {
    if (currentSource) { try { currentSource.stop(); } catch { /* already stopped */ } currentSource = null; }
    queue = Promise.resolve();
    set({ speaking: false });
  },
}));
