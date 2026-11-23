import { isDesktop, desktopInvokeBytes } from '../desktop/bridge';

// Save a file the page made (map export, admin CSV). In a browser that's a
// download link. In the desktop app it goes through the app's save dialog:
// the Linux webview never lets a blob: address into the window, so the link
// did nothing there. An older desktop app without that command (or any
// failure on its side) falls back to the link.
export async function saveFile(name: string, blob: Blob): Promise<void> {
  if (isDesktop()) {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await desktopInvokeBytes<boolean>('save_file', bytes, { 'x-file-name': encodeURIComponent(name) });
      return;
    } catch {
      // fall through to the link
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Some browsers read the address after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
