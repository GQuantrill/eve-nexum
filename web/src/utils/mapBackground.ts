// The map's background: a colour and grid (pilot settings, synced like the
// home colour), and an optional picture that stays on this device only.
//
// The picture is never uploaded. It is scaled down once when picked (at most
// MAX_SIDE pixels a side, re-encoded, which also drops any photo metadata) and
// kept in IndexedDB as a data: URL -- data: because the site's CSP already
// allows data: images, so self-hosters' nginx needs no change. Fit and darken
// stay on the device with it.
//
// On a corp or alliance install an admin can also offer up to five pictures
// (server/src/services/orgBackgrounds.ts), one the default. A pilot sees the
// default, or picks another or none (BG_CHOICE_KEY, synced); their own picture
// on this device overrides all of that.
import { useSyncExternalStore } from 'react';
import { api, apiUrl } from '../api/client';

export const MAP_BG_COLOR_KEY = 'nexum.map.bgColor';
export const MAP_BG_COLOR_DEFAULT = '#0b0e16'; // --surface-sunken
export const GRID_COLOR_KEY = 'nexum.map.gridColor';
/** The grid's colour when the pilot hasn't picked one ('' = these). */
export const GRID_COLOR_AUTO = { lines: '#1a2240', snapDots: '#3a4a7a', dots: '#1a2040' };
export const SHOW_GRID_KEY = 'nexum.map.showGrid';

export const BG_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const MAX_SIDE = 3840;

export type BgFit = 'cover' | 'contain' | 'tile';
export const BG_FITS: BgFit[] = ['cover', 'contain', 'tile'];
const FIT_KEY = 'nexum.local.mapBgFit';
const DIM_KEY = 'nexum.local.mapBgDim';
export const BG_DIM_DEFAULT = 60;

const DB = 'nexum-local';
const STORE = 'files';
const IMAGE_ID = 'mapBackground';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

function readLocal<T>(key: string, ok: (v: unknown) => v is T, fallback: T): T {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode / quota */ }
}

export interface BgImageState {
  /** The picture as a data: URL, or null for none. */
  url: string | null;
  fit: BgFit;
  /** How much the background colour covers the picture, 0-90. */
  dim: number;
}

const isFit = (v: unknown): v is BgFit => BG_FITS.includes(v as BgFit);
const isDim = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 90;

let state: BgImageState = {
  url: null,
  fit: readLocal(FIT_KEY, isFit, 'cover'),
  dim: readLocal(DIM_KEY, isDim, BG_DIM_DEFAULT),
};
const listeners = new Set<() => void>();
let loaded = false;

function set(next: Partial<BgImageState>): void {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!loaded) {
    loaded = true;
    idb<string | undefined>('readonly', (s) => s.get(IMAGE_ID))
      .then((url) => { if (typeof url === 'string' && url.startsWith('data:image/')) set({ url }); })
      .catch(() => { /* no IndexedDB (private mode): no picture */ });
  }
  return () => { listeners.delete(cb); };
}

/** The picture's state, shared by the map and the settings. */
export function useMapBgImage(): BgImageState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function setBgFit(fit: BgFit): void { writeLocal(FIT_KEY, fit); set({ fit }); }
export function setBgDim(dim: number): void {
  const d = Math.max(0, Math.min(90, Math.round(dim)));
  writeLocal(DIM_KEY, d); set({ dim: d });
}

/** Too big, or not a picture the browser can read. */
export class BgImageError extends Error {
  constructor(readonly reason: 'tooBig' | 'unreadable') { super(reason); }
}

async function readPicture(file: File): Promise<ImageBitmap> {
  if (file.size > BG_IMAGE_MAX_BYTES) throw new BgImageError('tooBig');
  try { return await createImageBitmap(file); } catch { throw new BgImageError('unreadable'); }
}

/** `bmp` at most `maxSide` a side, as a data: URL. WebP keeps transparency and
 *  is small; a browser that can't write it hands back PNG, so JPEG there. */
function encode(bmp: ImageBitmap, maxSide: number, quality: number): string {
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  let url = canvas.toDataURL('image/webp', quality);
  if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', quality);
  if (!url.startsWith('data:image/')) throw new BgImageError('unreadable');
  return url;
}

/** Scale the picked file down, keep it on this device and show it. */
export async function setBgImage(file: File): Promise<void> {
  const bmp = await readPicture(file);
  let url: string;
  try { url = encode(bmp, MAX_SIDE, 0.9); } finally { bmp.close(); }
  await idb('readwrite', (s) => s.put(url, IMAGE_ID));
  set({ url });
}

/** Upload cap for an org picture (server/src/services/orgBackgrounds.ts). */
const ORG_MAX_BYTES = 700 * 1024;

/** An admin's picture for the org, scaled and compressed until it fits the
 *  upload cap: base64, without the data: prefix. */
export async function encodeOrgBackground(file: File): Promise<string> {
  const bmp = await readPicture(file);
  try {
    for (const [side, q] of [[2560, 0.85], [2560, 0.7], [1920, 0.75], [1920, 0.6], [1280, 0.6]] as const) {
      const b64 = encode(bmp, side, q).split(',')[1] ?? '';
      if (b64.length * 0.75 <= ORG_MAX_BYTES) return b64;
    }
  } finally {
    bmp.close();
  }
  throw new BgImageError('tooBig');
}

export async function clearBgImage(): Promise<void> {
  set({ url: null });
  await idb('readwrite', (s) => s.delete(IMAGE_ID)).catch(() => {});
}

// ── The org's pictures ──────────────────────────────────────────────────────

/** Which of the org's pictures a pilot shows: theirs to choose. */
export const BG_CHOICE_KEY = 'nexum.map.bgChoice';
/** 'default' = whatever the admin made the default; 'none' = no picture. */
export const BG_CHOICE_DEFAULT = 'default';

export interface OrgBackground { id: string; name: string; isDefault: boolean }
export interface OrgBackgrounds { enabled: boolean; backgrounds: OrgBackground[] }

const NO_ORG: OrgBackgrounds = { enabled: false, backgrounds: [] };
let org: OrgBackgrounds = NO_ORG;
let orgLoad: Promise<void> | null = null;
const orgListeners = new Set<() => void>();

/** Fetch the org's list again (after an admin changed it). */
export function reloadOrgBackgrounds(): Promise<void> {
  orgLoad = api<OrgBackgrounds>('/api/backgrounds')
    .then((r) => { org = r && Array.isArray(r.backgrounds) ? r : NO_ORG; })
    .catch(() => { org = NO_ORG; })
    .then(() => { orgListeners.forEach((l) => l()); });
  return orgLoad;
}

function subscribeOrg(cb: () => void): () => void {
  orgListeners.add(cb);
  if (!orgLoad) void reloadOrgBackgrounds();
  return () => { orgListeners.delete(cb); };
}

/** The pictures the pilot's admin offers ({ enabled: false } on a solo install). */
export function useOrgBackgrounds(): OrgBackgrounds {
  return useSyncExternalStore(subscribeOrg, () => org, () => org);
}

export function orgBackgroundUrl(id: string): string {
  return apiUrl(`/api/backgrounds/${encodeURIComponent(id)}`);
}

/** The picture to show: the pilot's own, else their pick of the org's (or the
 *  org's default), else none. */
export function shownBackground(own: string | null, choice: unknown, list: OrgBackground[]): string | null {
  if (own) return own;
  if (choice === 'none') return null;
  const picked = list.find((b) => b.id === choice) ?? list.find((b) => b.isDefault);
  return picked ? orgBackgroundUrl(picked.id) : null;
}

/** CSS for the picture layer: the background colour over it at `dim`. */
export function bgImageStyle(img: BgImageState, color: string, url: string | null = img.url): React.CSSProperties | null {
  if (!url) return null;
  const veil = `color-mix(in srgb, ${color} ${img.dim}%, transparent)`;
  return {
    backgroundImage: `linear-gradient(${veil}, ${veil}), url("${url}")`,
    backgroundSize: img.fit === 'tile' ? 'auto, auto' : `auto, ${img.fit}`,
    backgroundRepeat: img.fit === 'tile' ? 'repeat' : 'no-repeat',
    backgroundPosition: 'center',
  };
}
