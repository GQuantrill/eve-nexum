import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '../../icons';

/**
 * Tripwire has no export, so this imports the JSON its own web client receives.
 *
 * The snippet below is handed to the user to run in the console on their open
 * Tripwire tab: it re-requests the same chain endpoint using the session they
 * already have and copies the reply. Nothing is typed into Nexum but the
 * result, and no Tripwire credentials are involved at any point — which is the
 * whole reason for doing it this way rather than asking for a login.
 *
 * One call is enough for the SHAPE of the chain — refresh.php returns the
 * mask's whole `wormholes` table and every wormhole signature, not just what's
 * on screen — but not for its contents. Notes come back only for the system
 * asked about, and so do the other signature types (relic, data, gas, combat,
 * ghost). So the snippet walks the systems it just learned about and collects
 * both, which is why one run on any system brings in the whole chain rather
 * than needing a pass per tab. Three details that matter:
 *   - the `signatureCount`/`commentCount` pairs are deliberately impossible to
 *     match. That's what makes Tripwire send the data rather than "no change".
 *   - signatures merge over the initial reply rather than replacing it: each
 *     call returns that system's own sigs plus every wormhole, so the union
 *     across the walk is the full chain.
 *   - every one of those calls also stamps that system as where you are, so
 *     corp-mates watching Tripwire would see you skip down the chain. The last
 *     line puts you back where you started.
 *
 * Which system you're on comes from `viewingSystemID`, the page global
 * Tripwire's own sync reads. The `?system=` in the URL is the system's NAME,
 * not its id, and refresh.php answers a name with a 500.
 *
 * It all sits inside an async IIFE rather than at the top level. Tripwire's own
 * page declares globals of its own — `var chain` among them — and a top-level
 * `const chain` in the console collides with it outright ("Identifier 'chain'
 * has already been declared"). Scoping the lot also makes the snippet safe to
 * paste twice.
 *
 * `copy()` is DevTools' own console helper, and it's only in scope while the
 * pasted statement is still running synchronously — by the first `await` it's
 * gone ("copy is not defined"). So it's captured up front, and the result is
 * parked on `window.twChain` regardless, leaving `copy(twChain)` as a one-word
 * second step if the captured helper won't fire.
 */
const SNIPPET = `await (async () => {
  const cp = typeof copy === 'function' ? copy : null;
  const here = String(window.viewingSystemID || '');
  if (!here) throw new Error('No system in view - open your Tripwire map first, then run this again.');
  const get = async q => {
    const r = await fetch('/refresh.php?' + q, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('Tripwire replied ' + r.status + ' to ' + q);
    return r.json();
  };
  const data = await get('mode=init&systemID=' + here);
  const sigs = Object.values(data.signatures || {});
  const ids = [...new Set(sigs.map(s => String(s.systemID)))];
  const notes = {}, sticky = new Map(), all = { ...data.signatures };
  for (const [i, id] of ids.entries()) {
    const r = await get('mode=refresh&systemID=' + id + '&signatureCount=-1&signatureTime=1970-01-01&commentCount=-1&commentTime=1970-01-01');
    Object.assign(all, r.signatures || {});
    for (const c of r.comments || []) c.sticky ? sticky.set(c.id, c) : (notes[id] = notes[id] || []).push(c);
    if (ids.length > 20 && i % 10 === 9) console.log((i + 1) + '/' + ids.length + ' systems...');
  }
  notes['0'] = [...sticky.values()];
  await get('mode=refresh&systemID=' + here);
  window.twChain = JSON.stringify({ ...data, signatures: all, origin: here, notes });
  const tally = ids.length + ' systems, ' + Object.keys(all).length + ' signatures';
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
