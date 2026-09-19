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
 * System notes need a second pass. Tripwire's chain reply carries the comments
 * for the one system it was asked about and nothing else, so the snippet walks
 * the systems it just learned about and asks for each one's notes. Two details
 * that cost nothing and matter:
 *   - the `commentCount`/`commentTime` pair is deliberately impossible to
 *     match, which is what makes Tripwire send the notes rather than "no
 *     change". The signature count is the opposite: it's the best guess we can
 *     make from the chain we already hold, and where it lands on the real
 *     number Tripwire skips resending that system's signatures.
 *   - every one of those calls also stamps that system as where you are, so
 *     corp-mates watching Tripwire would see you skip down the chain. The last
 *     line puts you back where you started.
 */
const SNIPPET = `const here = new URLSearchParams(location.search).get('system') || '30000142';
const get = q => fetch('/refresh.php?' + q, { credentials: 'same-origin' }).then(r => r.json());
const chain = await get('mode=init&systemID=' + here);
const sigs = Object.values(chain.signatures || {});
const ids = [...new Set(sigs.map(s => String(s.systemID)))];
const notes = {}, sticky = new Map();
for (const id of ids) {
  const n = sigs.filter(s => String(s.systemID) === id || s.type === 'wormhole').length;
  const r = await get('mode=refresh&systemID=' + id + '&signatureCount=' + n + '&signatureTime=2100-01-01&commentCount=-1&commentTime=1970-01-01');
  for (const c of r.comments || []) c.sticky ? sticky.set(c.id, c) : (notes[id] = notes[id] || []).push(c);
}
notes['0'] = [...sticky.values()];
await get('mode=refresh&systemID=' + here);
copy(JSON.stringify({ ...chain, origin: here, notes }));
console.log('Copied ' + ids.length + ' systems.');`;

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
