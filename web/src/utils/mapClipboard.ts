// Copy and paste systems between maps (server: services/mapPaste.ts). Copy
// asks the server for the selected systems with their links, signatures,
// anomalies and structures, and puts that on the clipboard as one line of
// JSON. Paste sends it to the map you are on, which adds only what it is
// missing. Because it is just clipboard text it works between two nexum
// servers as well (an alliance install and eve-nexum.com, say).

import { api } from '../api/client';

export const CLIP_FORMAT = 'nexum-systems';

/** A saved chain as a path of clip system ids. */
export interface ClipChain { name: string; systemIds: string[] }

/** What an import adds to a paste (selectionImport.ts). */
export interface PasteExtras { mergeLabels?: boolean; chains?: ClipChain[] }

export interface PasteResult {
  systems: number; connections: number; signatures: number; anomalies: number; structures: number;
  labels: number; chains: number;
  matched: number;
  focus: { x: number; y: number } | null;
}

/** The clip in some clipboard text, or null if it isn't one. */
export function parseClip(text: string): Record<string, unknown> | null {
  const t = text.trim();
  // Cheap check first: every other paste on the map (scans, d-scans, names)
  // lands here too.
  if (!t.startsWith('{') || !t.includes(`"${CLIP_FORMAT}"`)) return null;
  try {
    const v: unknown = JSON.parse(t);
    if (v && typeof v === 'object' && !Array.isArray(v)
      && (v as { format?: unknown }).format === CLIP_FORMAT
      && Array.isArray((v as { systems?: unknown }).systems)) {
      return v as Record<string, unknown>;
    }
  } catch { /* not JSON */ }
  return null;
}

/**
 * Put the systems on the clipboard. Resolves the number copied. The clipboard
 * write is started inside the click (as a ClipboardItem waiting on the fetch),
 * because Safari and WebKit refuse a write that only starts after an await.
 */
export async function copySystems(mapId: string, systemIds: string[]): Promise<number> {
  let count = 0;
  const text = api<{ systems: unknown[] }>(`/api/maps/${mapId}/clip`, {
    method: 'POST', body: JSON.stringify({ systemIds }),
  }).then((clip) => { count = clip.systems.length; return JSON.stringify(clip); });

  const clipboard = navigator.clipboard;
  if (typeof ClipboardItem !== 'undefined' && clipboard?.write) {
    try {
      await clipboard.write([new ClipboardItem({
        'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })),
      })]);
      return count;
    } catch (err) {
      // A failed fetch is the real error; anything else, try the plain write.
      await text;
      if (!clipboard.writeText) throw err;
    }
  }
  if (!clipboard?.writeText) throw new Error('clipboard unavailable');
  await clipboard.writeText(await text);
  return count;
}

export function pasteSystems(
  mapId: string, clip: Record<string, unknown>, anchor: { x: number; y: number } | null, extras: PasteExtras = {},
): Promise<PasteResult> {
  return api<PasteResult>(`/api/maps/${mapId}/paste`, {
    method: 'POST', body: JSON.stringify({ clip, anchor, ...extras }),
  });
}
