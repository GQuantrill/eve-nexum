import { create } from 'zustand';
import { onDesktopEvent } from './bridge';

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

export function startScanPaste(): () => void {
  const offProbe = onDesktopEvent<{ text: string }>('nexum://scan', ({ text }) => {
    if (!text) return;
    try {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    } catch { /* an old webview without DataTransfer: skip */ }
  });
  const offDscan = onDesktopEvent<{ text: string }>('nexum://dscan', ({ text }) => {
    if (!text) return;
    useDscanRequest.setState((s) => ({ text, seq: s.seq + 1 }));
  });
  return () => { offProbe(); offDscan(); };
}
