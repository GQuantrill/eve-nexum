// Copy text to the clipboard from code that isn't a click handler -- a jump
// seen by the location poll, say. Browsers only let a focused page write the
// clipboard, and right after a jump the pilot is in the game client, not here.
// So when the page isn't focused the text waits, and is written the moment the
// pilot clicks back into nexum. Only the latest text waits (a newer jump
// replaces an older one), and not for long: clipboard contents that turn up
// half an hour later would be a surprise, not a help.

const MAX_WAIT_MS = 5 * 60_000;

let pending: { text: string; at: number; done: (ok: boolean) => void } | null = null;

function write(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return Promise.resolve(false);
  return navigator.clipboard.writeText(text).then(() => true, () => false);
}

function onFocus(): void {
  window.removeEventListener('focus', onFocus);
  const p = pending;
  pending = null;
  if (!p) return;
  if (Date.now() - p.at > MAX_WAIT_MS) { p.done(false); return; }
  void write(p.text).then(p.done);
}

/** Resolves true once the text is on the clipboard, false if that failed, the
 *  wait ran out, or a newer copy took its place. */
export function copyWhenFocused(text: string): Promise<boolean> {
  if (pending) { pending.done(false); pending = null; }
  if (document.hasFocus()) return write(text);
  return new Promise((resolve) => {
    pending = { text, at: Date.now(), done: resolve };
    window.addEventListener('focus', onFocus);
  });
}
