/// <reference types="vite/client" />

// Build-time flags for the voice announcer (set by web/Dockerfile). Unset in dev,
// where the model + ORT wasm load from the Hugging Face hub / jsdelivr instead.
interface ImportMetaEnv {
  /** 'true' when the Docker build self-hosts the model + ORT wasm same-origin. */
  readonly VITE_ANNOUNCER_SELF_HOSTED?: string;
  /** Kokoro weight precision: 'q8' (default) | 'fp16' | 'fp32' | 'q4' | 'q4f16'. */
  readonly VITE_ANNOUNCER_DTYPE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
