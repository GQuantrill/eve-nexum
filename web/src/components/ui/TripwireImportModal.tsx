import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '../../icons';
import { buildSnippet, parseExtraSystems } from '../../utils/tripwireSnippet';


export function TripwireImportModal({ onImport, onClose }: {
  onImport: (json: string) => Promise<void>;
  onClose:  () => void;
}) {
  const { t } = useTranslation();
  const [json, setJson] = useState('');
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Named systems ride inside the snippet, so it's rebuilt as they're typed —
  // the user copies once and pastes once, rather than editing the script.
  const extraList = useMemo(() => parseExtraSystems(extra), [extra]);
  const snippet = useMemo(() => buildSnippet(extraList), [extraList]);

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
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

          <label className="field">
            <span>{t('tripwire.extraLabel')}</span>
            <input
              className="tripwire-modal__extra"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder={t('tripwire.extraPlaceholder')}
              spellCheck={false}
            />
            <small className="tripwire-modal__hint">
              {extraList.length > 0 ? t('tripwire.extraCount', { count: extraList.length }) : t('tripwire.extraHint')}
            </small>
          </label>

          <div className="tripwire-modal__snippet">
            <pre><code>{snippet}</code></pre>
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
