import { create } from 'zustand';
import { onDesktopEvent } from './bridge';
import i18n from 'i18next';
import { toast } from '../utils/toastStore';
import { trackedCharacterName } from '../hooks/useCharacterLocation';

// Desktop only: the app watches the clipboard (when the pilot turns that on)
// and sends scans copied in EVE here. Nothing else on the clipboard is ever
// sent by the app.
//
// - Probe-scanner results go through the same path as a Ctrl+V on the map, so
//   the signature and anomaly panes treat them exactly like a manual paste,
//   into whichever system is selected, with the same "you're in a different
//   system" check.
// - A d-scan opens the d-scan analyser (the toolbar's) with the scan filled
//   in. Nothing is analysed, saved or pinned until the pilot says so there.

interface DscanRequest {
  /** The copied scan, or null when none is waiting. */
  text: string | null;
  /** Bumped per scan, so a second copy replaces the first in an open analyser. */
  seq: number;
  clear: () => void;
}

export const useDscanRequest = create<DscanRequest>((set) => ({
  text: null,
  seq: 0,
  clear: () => set({ text: null }),
}));

interface Scan {
  text: string;
  /** The character in the EVE window it was copied in, when the app could
   *  tell (app 0.1.2+). */
  character?: string | null;
  /** The pilot's "only the tracked character's scans" setting. */
  trackedOnly?: boolean;
}

/** With "tracked character only" on, a scan copied in another character's
 *  EVE window (or one the app couldn't name) is not used. Says so, so it
 *  doesn't look broken. */
export function scanAllowed(scan: Scan, tracked: string | null): boolean {
  if (!scan.trackedOnly || !tracked) return true;
  return !!scan.character && scan.character.toLowerCase() === tracked.toLowerCase();
}

function allowed(scan: Scan): boolean {
  const tracked = trackedCharacterName();
  if (scanAllowed(scan, tracked)) return true;
  toast.info(i18n.t('scanPaste.otherCharacter', { name: tracked }));
  return false;
}

export function startScanPaste(): () => void {
  const offProbe = onDesktopEvent<Scan>('nexum://scan', (scan) => {
    const { text } = scan;
    if (!text || !allowed(scan)) return;
    try {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    } catch { /* an old webview without DataTransfer: skip */ }
  });
  const offDscan = onDesktopEvent<Scan>('nexum://dscan', (scan) => {
    const { text } = scan;
    if (!text || !allowed(scan)) return;
    useDscanRequest.setState((s) => ({ text, seq: s.seq + 1 }));
  });
  return () => { offProbe(); offDscan(); };
}
