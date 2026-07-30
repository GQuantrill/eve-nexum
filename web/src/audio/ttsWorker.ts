/// <reference lib="webworker" />
// Kokoro TTS runs here, OFF the main thread, so model init and generation (WASM
// CPU inference, seconds per phrase) never freeze the UI. The main thread
// (announcer.ts) posts {load} / {generate} and gets back progress, a ready
// signal, and raw Float32 audio samples (transferred, not copied) which it plays
// via Web Audio. Self-hosting + the voice cache-prime live here too — CacheStorage
// is per-origin, shared with the window, so priming here is visible to kokoro.
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const SELF_HOSTED = import.meta.env.VITE_ANNOUNCER_SELF_HOSTED === 'true';
const DTYPE = (import.meta.env.VITE_ANNOUNCER_DTYPE as string) || (SELF_HOSTED ? 'q8' : 'fp32');
const LOCAL_MODEL_PATH = '/models/';
const LOCAL_WASM_PATH = '/ort/';
const LOCAL_VOICES_BASE = `${LOCAL_MODEL_PATH}${MODEL_ID}/voices`;

const KOKORO_VOICE_CACHE = 'kokoro-voices';
const primed = new Set<string>();
async function primeVoice(id: string): Promise<void> {
  if (!SELF_HOSTED || primed.has(id)) return;
  try {
    const cache = await caches.open(KOKORO_VOICE_CACHE);
    const key = `https://huggingface.co/${MODEL_ID}/resolve/main/voices/${id}.bin`;
    if (!(await cache.match(key))) {
      const res = await fetch(`${LOCAL_VOICES_BASE}/${id}.bin`);
      if (!res.ok) return;
      await cache.put(key, new Response(await res.arrayBuffer()));
    }
    primed.add(id);
  } catch { /* CacheStorage unavailable — kokoro falls back to its own path */ }
}

let tts: KokoroTTS | null = null;
let loadPromise: Promise<void> | null = null;

type VoiceId = NonNullable<Parameters<KokoroTTS['generate']>[1]>['voice'];
type DtypeOpt = NonNullable<Parameters<typeof KokoroTTS.from_pretrained>[1]>['dtype'];

const post = (msg: Record<string, unknown>, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer ?? []);

function load(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const wasm = env.backends.onnx.wasm as { numThreads?: number; wasmPaths?: string };
    wasm.numThreads = 1;
    if (SELF_HOSTED) {
      wasm.wasmPaths = LOCAL_WASM_PATH;
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      env.localModelPath = LOCAL_MODEL_PATH;
      env.useBrowserCache = true;
    }
    tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      device: 'wasm',
      dtype: DTYPE as DtypeOpt,
      progress_callback: (p: unknown) => {
        const pr = (p as { progress?: number }).progress;
        if (typeof pr === 'number') post({ type: 'progress', progress: Math.round(pr) });
      },
    });
    // Warm up: ONNX Runtime's FIRST inference compiles/optimises kernels and is
    // much slower than steady state. Run one throwaway generation now — behind the
    // loading UI — so the user's first real announcement pays only steady-state
    // cost, not the cold-start penalty. Non-fatal if it fails.
    try {
      await primeVoice('af_nicole');
      await tts.generate('warming up', { voice: 'af_nicole' as VoiceId });
    } catch { /* warm-up is best-effort */ }
  })().catch((e: unknown) => { loadPromise = null; throw e; });
  return loadPromise;
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as { type: string; id?: number; text?: string; voice?: string };
  if (msg.type === 'load') {
    try { await load(); post({ type: 'ready', backend: `wasm/${DTYPE}${SELF_HOSTED ? '/self-hosted' : ''}` }); }
    catch (err) { post({ type: 'loadError', error: err instanceof Error ? err.message : String(err) }); }
    return;
  }
  if (msg.type === 'generate') {
    try {
      if (!tts) await load();
      const voice = msg.voice ?? 'af_nicole';
      await primeVoice(voice);
      const audio = await tts!.generate((msg.text ?? '').slice(0, 300), { voice: voice as VoiceId });
      const samples = audio.audio as Float32Array;
      post({ type: 'audio', id: msg.id, samples, rate: audio.sampling_rate }, [samples.buffer]);
    } catch (err) {
      post({ type: 'genError', id: msg.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
};
