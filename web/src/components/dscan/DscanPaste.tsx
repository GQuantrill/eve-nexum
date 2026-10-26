import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import styles from './Dscan.module.css';

/** Where a new scan can be pinned: a system on the active map. */
export interface ScanAttachTarget {
  mapId: string;
  systemId: string;
  systemName: string;
}

const ERROR_KEYS = {
  empty:         'dscan.errors.empty',
  unrecognised:  'dscan.errors.unrecognised',
  too_many:      'dscan.errors.tooMany',
  invalid_text:  'dscan.errors.tooMany',
  lookup_failed: 'dscan.errors.lookupFailed',
} as const;

/**
 * The paste box. Posts the raw text; the server works out whether it is a
 * d-scan or a local list and hands back the new scan's id.
 */
export function DscanPaste({ attach, onCreated }: {
  attach?: ScanAttachTarget | null;
  onCreated: (id: string, pinned: boolean) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [pin, setPin] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    if (!text.trim()) { setError(t('dscan.errors.empty')); return; }
    setBusy(true);
    setError(null);
    const pinned = !!attach && pin;
    try {
      const res = await api<{ id: string }>('/api/dscan', {
        method: 'POST',
        body: JSON.stringify({
          text,
          ...(pinned ? { mapId: attach.mapId, systemId: attach.systemId } : null),
        }),
      });
      setText('');
      onCreated(res.id, pinned);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      const status = err instanceof ApiError ? err.status : 0;
      setError(
        status === 429 ? t('dscan.errors.rateLimited')
          : code && code in ERROR_KEYS ? t(ERROR_KEYS[code as keyof typeof ERROR_KEYS])
          : t('dscan.errors.failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.paste}>
      <p className={styles.intro}>{t('dscan.intro')}</p>
      <textarea
        className={styles.textarea}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit(); }}
        placeholder={t('dscan.placeholder')}
        aria-label={t('dscan.placeholder')}
        spellCheck={false}
        autoFocus
      />
      <div className={styles.pasteActions}>
        <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={busy}>
          {busy ? t('dscan.analysing') : t('dscan.analyse')}
        </button>
        {attach && (
          <label className={styles.attach}>
            <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} />
            {t('dscan.attachTo', { system: attach.systemName })}
          </label>
        )}
      </div>
      {error && <div className={styles.error} role="alert">{error}</div>}
    </div>
  );
}
