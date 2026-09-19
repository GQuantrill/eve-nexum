import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '../../icons';

/**
 * Tripwire has no export, so this imports the JSON its own web client receives.
 *
 * The snippet below is handed to the user to run in the console on their open
 * Tripwire tab: it re-requests their data using the session they already have
 * and copies the reply. Nothing is typed into Nexum but the result, and no
 * Tripwire credentials are involved at any point — which is the whole reason
 * for doing it this way rather than asking for a login.
 *
 * It reads `api.php?q=/<resource>&maskID=<mask>`, which returns a whole mask in
 * one call. The obvious alternative, refresh.php (what the Tripwire page itself
 * polls), answers for ONE system at a time: its `wormholes` are mask-wide, but
 * notes and the non-wormhole signature types come back only for the system
 * asked about. Walking the chain to collect those reaches every system that has
 * a hole on it and no others — so a system someone annotated but never
 * connected stays invisible however many times you run it. api.php has no such
 * blind spot, needs no walk, and doesn't stamp you as present in each system it
 * asks about.
 *
 * refresh.php is still called once, only to learn which mask the session is on:
 * api.php requires that id and nothing hands it over on its own.
 *
 * Two details about the console itself:
 *   - everything sits inside an async IIFE. Tripwire's page declares globals of
 *     its own — `var chain` among them — and a top-level `const chain` collides
 *     with it outright. Scoping also makes the snippet safe to paste twice.
 *   - `copy()` is DevTools' own helper and only exists while the pasted
 *     statement is still running synchronously; by the first `await` it's gone.
 *     So it's captured up front, and the result is parked on `window.twChain`
 *     regardless, leaving `copy(twChain)` as a one-word second step.
 */
const SNIPPET = `await (async () => {
  const cp = typeof copy === 'function' ? copy : null;
  const here = String(window.viewingSystemID || '');
  if (!here) throw new Error('No system in view - open your Tripwire map first, then run this again.');
  const grab = async (url, what) => {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('Tripwire replied ' + r.status + ' for ' + what);
    return r.json();
  };
  const init = await grab('/refresh.php?mode=init&systemID=' + here, 'the chain');
  const maskFrom = o => { for (const v of Object.values(o || {})) if (v && v.maskID) return String(v.maskID); return ''; };
  const mask = maskFrom(init.signatures) || maskFrom(init.wormholes) || String((window.tripwire && tripwire.mask) || '');
  if (!mask) throw new Error('Could not work out which mask you are on - is there anything scanned on it?');
  const api = res => grab('/api.php?q=/' + res + '&maskID=' + mask, res);
  const [sigs, whs, comments] = await Promise.all([api('signatures'), api('wormholes'), api('comments')]);
  const byId = rows => Object.fromEntries(rows.map(r => [String(r.id), r]));
  const notes = {};
  for (const c of comments) (notes[String(c.systemID)] = notes[String(c.systemID)] || []).push(c);
  window.twChain = JSON.stringify({ signatures: byId(sigs), wormholes: byId(whs), origin: here, notes });
  const tally = new Set(sigs.map(s => String(s.systemID))).size + ' systems, '
    + sigs.length + ' signatures, ' + comments.length + ' notes';
  try { cp(twChain); console.log('Copied ' + tally + ' to the clipboard.'); }
  catch (e) { console.log('Collected ' + tally + '. Now run:  copy(twChain)'); }
})();`;

export function TripwireImportModal({ onImport, onClose }: {
  onImport: (json: string) => Promise<void>;
  onClose:  () => void;
}) {
  const { t } = useTranslation();
  const [json, setJson] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(SNIPPET);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked — the snippet is selectable on screen */ }
  };

  const run = async () => {
    setBusy(true);
    try { await onImport(json); } finally { setBusy(false); }
  };

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal tripwire-modal" role="dialog" aria-modal="true">
        <div className="modal__header">
          <h2 className="modal__title">{t('tripwire.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={16} weight="bold" />
          </button>
        </div>
        <div className="modal__body">
          <ol className="tripwire-modal__steps">
            <li>{t('tripwire.step1')}</li>
            <li>{t('tripwire.step2')}</li>
            <li>{t('tripwire.step3')}</li>
          </ol>

          <div className="tripwire-modal__snippet">
            <pre><code>{SNIPPET}</code></pre>
            <button type="button" className="btn btn--ghost" onClick={copySnippet}>
              {copied ? t('tripwire.copied') : t('actions.copy')}
            </button>
          </div>

          <label className="field">
            <span>{t('tripwire.pasteLabel')}</span>
            <textarea
              className="tripwire-modal__input"
              value={json}
              onChange={(e) => setJson(e.target.value)}
              placeholder={t('tripwire.pastePlaceholder')}
              spellCheck={false}
              rows={6}
            />
          </label>

          <p className="tripwire-modal__note">{t('tripwire.scopeNote')}</p>

          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={onClose}>{t('actions.cancel')}</button>
            <button className="btn btn--primary" onClick={() => void run()} disabled={!json.trim() || busy}>
              {busy ? t('tripwire.importing') : t('tripwire.import')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
