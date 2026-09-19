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
 * There are two ways to get the data, and which one works depends on the
 * deployment, so it tries both:
 *
 *  1. `api.php?q=/<resource>&maskID=<mask>` returns a whole mask in one call.
 *     Some instances answer it on the session cookie; others don't expose it at
 *     all (a self-hosted one was seen returning 503 for every resource).
 *  2. refresh.php, what the Tripwire page itself polls. Its `wormholes` are
 *     mask-wide, but notes and the non-wormhole signature types come back only
 *     for the system asked about, so this walks the chain to collect them.
 *
 * The walk reaches every system that has a hole on it and no others, which is
 * the one thing path 1 does better: a system someone annotated but never
 * connected is invisible to refresh.php however many times you run it, because
 * nothing will name it. Worth preferring path 1 for, and worth saying out loud
 * in the console when we fall back.
 *
 * The mask id that api.php needs is read off the page — Tripwire keeps the list
 * in `tripwire.masks` with the active one flagged, and renders it into `#mask`
 * as `data-mask`. Recovering it from a signature row instead would fail on a
 * mask with nothing scanned, which has nothing to do with knowing the mask.
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
    if (!r.ok) throw new Error('replied ' + r.status + ' for ' + what);
    return r.json();
  };
  const byId = rows => Object.fromEntries(rows.map(r => [String(r.id), r]));
  const act = (window.tripwire && Array.isArray(tripwire.masks) && tripwire.masks.find(m => m.active)) || null;
  const el = document.querySelector('#mask [data-mask]') || document.querySelector('#mask-menu .active [data-mask]');
  const mask = String((act && act.mask) || (el && el.dataset.mask) || '');
  let sigs, whs;
  const notes = {};
  try {
    if (!mask) throw new Error('found no mask id on the page');
    const api = res => grab('/api.php?q=/' + res + '&maskID=' + mask, res);
    const [s, w, c] = await Promise.all([api('signatures'), api('wormholes'), api('comments')]);
    sigs = byId(s); whs = byId(w);
    for (const n of c) (notes[String(n.systemID)] = notes[String(n.systemID)] || []).push(n);
  } catch (e) {
    console.log('Whole-mask API unavailable here (' + e.message + ') - walking the chain instead.');
    console.log('Systems with notes but no wormhole on them cannot be reached this way.');
    const init = await grab('/refresh.php?mode=init&systemID=' + here, 'the chain');
    sigs = { ...init.signatures }; whs = { ...init.wormholes };
    const ids = [...new Set(Object.values(sigs).map(x => String(x.systemID)))];
    const sticky = new Map();
    for (const [i, id] of ids.entries()) {
      const r = await grab('/refresh.php?mode=refresh&systemID=' + id + '&signatureCount=-1&signatureTime=1970-01-01&commentCount=-1&commentTime=1970-01-01', 'system ' + id);
      Object.assign(sigs, r.signatures || {});
      for (const n of r.comments || []) n.sticky ? sticky.set(n.id, n) : (notes[id] = notes[id] || []).push(n);
      if (ids.length > 20 && i % 10 === 9) console.log((i + 1) + '/' + ids.length + ' systems...');
    }
    notes['0'] = [...sticky.values()];
    await grab('/refresh.php?mode=refresh&systemID=' + here, 'your own system');
  }
  window.twChain = JSON.stringify({ signatures: sigs, wormholes: whs, origin: here, notes });
  const list = Object.values(sigs);
  const tally = new Set(list.map(x => String(x.systemID))).size + ' systems, ' + list.length
    + ' signatures, ' + Object.values(notes).reduce((n, a) => n + a.length, 0) + ' notes';
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
