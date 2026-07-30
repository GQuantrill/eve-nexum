// Build-time fetch of the self-hosted voice-announcer assets into dist/, so the
// running app loads everything same-origin (CSP connect-src 'self') with no
// Hugging Face / jsdelivr dependency at runtime. Run AFTER `vite build` (it writes
// into the built dist/). See web/Dockerfile.
//
//   1. Copy the ORT WebAssembly runtime -> dist/ort/           (env.wasmPaths)
//   2. Download the Kokoro model for the chosen dtype + config + all voice bins
//      -> dist/models/<model-id>/...                           (env.localModelPath)
//
// dtype comes from VITE_ANNOUNCER_DTYPE (default q8) and MUST match what
// announcer.ts requests. Node 20+ (global fetch).

import { mkdir, copyFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE   = dirname(fileURLToPath(import.meta.url));
const WEB    = resolve(HERE, '..');
const DIST   = join(WEB, 'dist');
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DTYPE  = (process.env.VITE_ANNOUNCER_DTYPE || 'q8').trim();

// transformers.js dtype -> onnx filename suffix (its DEFAULT_DTYPE_SUFFIX_MAPPING).
const SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', q4: '_q4', q4f16: '_q4f16' };
if (!(DTYPE in SUFFIX)) { console.error(`[fetch-model] unknown dtype "${DTYPE}"`); process.exit(1); }
const ONNX_FILE = `onnx/model${SUFFIX[DTYPE]}.onnx`;

const HF = (rfilename) => `https://huggingface.co/${MODEL_ID}/resolve/main/${rfilename}`;

async function fetchRetry(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
      if (res.status === 404) break;                 // won't recover
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  throw lastErr;
}

async function download(rfilename) {
  const dest = join(DIST, 'models', MODEL_ID, rfilename);
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetchRetry(HF(rfilename));
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buf);
  return buf.length;
}

async function main() {
  // 1) ORT wasm runtime -> dist/ort/
  const ortSrc = join(WEB, 'node_modules', '@huggingface', 'transformers', 'dist');
  const ortDir = join(DIST, 'ort');
  await mkdir(ortDir, { recursive: true });
  const ortFiles = (await readdir(ortSrc)).filter((f) => /^ort-.*\.(wasm|mjs)$/.test(f));
  for (const f of ortFiles) await copyFile(join(ortSrc, f), join(ortDir, f));
  console.log(`[fetch-model] copied ORT runtime: ${ortFiles.join(', ')}`);

  // 2) Model file list from the HF API, then download what the browser needs:
  //    every root-level .json (config/tokenizer), the chosen onnx, all voice bins.
  const api = await fetchRetry(`https://huggingface.co/api/models/${MODEL_ID}`);
  const { siblings } = await api.json();
  const files = siblings.map((s) => s.rfilename);
  const wanted = files.filter((f) =>
    (/^[^/]+\.json$/.test(f)) ||          // root config / tokenizer json
    f.startsWith('voices/') ||            // all voice style vectors
    f === ONNX_FILE,                      // the one onnx for our dtype
  );
  if (!wanted.includes(ONNX_FILE)) {
    console.error(`[fetch-model] ${ONNX_FILE} not found in ${MODEL_ID} (dtype=${DTYPE})`);
    process.exit(1);
  }

  console.log(`[fetch-model] dtype=${DTYPE} -> ${ONNX_FILE}; downloading ${wanted.length} files...`);
  let total = 0;
  // Small concurrency to keep the build snappy without hammering the hub.
  const queue = [...wanted];
  const workers = Array.from({ length: 6 }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) total += await download(f);
  });
  await Promise.all(workers);
  console.log(`[fetch-model] done: ${wanted.length} files, ${(total / 1e6).toFixed(1)} MB into dist/models/${MODEL_ID}/`);
}

main().catch((e) => { console.error('[fetch-model] FAILED:', e); process.exit(1); });
