import { onDesktopEvent } from './bridge';

// Desktop only: the app watches the clipboard (when the pilot turns that on)
// and sends probe-scanner results here. They go through the same path as a
// Ctrl+V on the map, so the signature and anomaly panes treat them exactly
// like a manual paste, into whichever system is selected, with the same
// "you're in a different system" check. Nothing else on the clipboard is
// ever sent by the app.
export function startScanPaste(): () => void {
  return onDesktopEvent<{ text: string }>('nexum://scan', ({ text }) => {
    if (!text) return;
    try {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    } catch { /* an old webview without DataTransfer: skip */ }
  });
}
