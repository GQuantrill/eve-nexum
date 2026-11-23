import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '../../icons';
import { api } from '../../api/client';
import { toast } from '../../utils/toastStore';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { useUserSetting } from '../../hooks/useUserSetting';
import { useWormholeTypes } from '../../hooks/useWormholeTypes';
import { useMapStore } from '../../store/mapStore';
import { pasteSystems } from '../../utils/mapClipboard';
import {
  readTable, checkRows, planImport, GROUP_MEANINGS, GROUP_MEANING_KEY,
  type GroupMeaning, type KnownSystem, type RawRow,
} from '../../utils/selectionImport';
import styles from './ImportSystemsModal.module.css';

// Import systems from CSV or tab-separated rows (utils/selectionImport.ts):
// paste or open a file, say what "group" means, check the preview, import the
// good rows. They go in through the map's paste, so a system the map already
// has stays as it is and only what's missing is added.

const LOOKUP_BATCH = 60;
const MAX_FILE = 2 * 1024 * 1024;

interface Props { mapId: string; anchor: { x: number; y: number } | null; onClose: () => void }

export function ImportSystemsModal({ mapId, anchor, onClose }: Props) {
  useEscapeClose(onClose);
  const { t } = useTranslation();
  const whTypes = useWormholeTypes();
  const [meaning, setMeaning] = useUserSetting<GroupMeaning>(GROUP_MEANING_KEY, 'map');
  const [text, setText] = useState('');
  const [known, setKnown] = useState<Map<string, KnownSystem>>(new Map());
  const [lookupFailed, setLookupFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const table: RawRow[] | null = useMemo(() => (text.trim() ? readTable(text) : null), [text]);

  // The system names the table uses, looked up in batches.
  useEffect(() => {
    if (!table) return;
    const names = [...new Set(table.flatMap((r) => [r.cells.system, r.cells['to-system']])
      .map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 2 && n.length <= 64 && !/,/.test(n)))];
    const missing = names.filter((n) => !known.has(n));
    if (!missing.length) return;
    let live = true;
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += LOOKUP_BATCH) batches.push(missing.slice(i, i + LOOKUP_BATCH));
    Promise.all(batches.map((b) => api<KnownSystem[]>(`/api/systems/lookup?names=${encodeURIComponent(b.join(','))}`)))
      .then((res) => {
        if (!live) return;
        setLookupFailed(false);
        setKnown((prev) => {
          const next = new Map(prev);
          for (const s of res.flat()) next.set(s.name.toLowerCase(), { eveSystemId: s.eveSystemId, name: s.name });
          // Names that aren't systems: remembered as not found, so they aren't asked again.
          for (const n of missing) if (!next.has(n)) next.set(n, { eveSystemId: 0, name: '' });
          return next;
        });
      })
      .catch(() => { if (live) setLookupFailed(true); });
    return () => { live = false; };
  }, [table, known]);

  const found = useMemo(() => new Map([...known].filter(([, v]) => v.eveSystemId > 0)), [known]);
  const waiting = !!table && !lookupFailed && table.some((r) =>
    [r.cells.system, r.cells['to-system']].some((n) => n.trim().length >= 2 && !known.has(n.trim().toLowerCase())));
  const rows = useMemo(() => (table && !waiting ? checkRows(table, found, whTypes) : []), [table, waiting, found, whTypes]);
  const good = rows.filter((r) => r.errors.length === 0);
  const plan = useMemo(() => planImport(rows, found, meaning), [rows, found, meaning]);

  const openFile = (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_FILE) { toast.error(t('importSystems.fileTooBig')); return; }
    f.text().then(setText).catch(() => toast.error(t('importSystems.fileFailed')));
  };

  const run = () => {
    if (!good.length || busy) return;
    setBusy(true);
    pasteSystems(mapId, plan.clip, anchor, { mergeLabels: plan.mergeLabels, chains: plan.chains })
      .then(async (r) => {
        toast.success(t('importSystems.done', {
          systems: r.systems, connections: r.connections, signatures: r.signatures, labels: r.labels, chains: r.chains,
        }));
        await useMapStore.getState().switchMap(mapId);
        onClose();
      })
      .catch(() => toast.error(t('importSystems.failed')))
      .finally(() => setBusy(false));
  };

  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${styles.wide}`} role="dialog" aria-modal="true">
        <div className="modal__header">
          <h2 className="modal__title">{t('importSystems.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={16} weight="bold" />
          </button>
        </div>

        <div className="modal__body">
          <p className="map-sidebar__hint">{t('importSystems.intro')}</p>

          <label className="field">
            <span>{t('importSystems.paste')}</span>
            <textarea className={styles.input} rows={6} value={text} spellCheck={false}
              placeholder="group,system,signature,to-system,from-type,to-type,size,mass-remaining,life-remaining"
              onChange={(e) => setText(e.target.value)} />
          </label>
          <div className={styles.fileRow}>
            <label className="btn btn--ghost">
              {t('importSystems.openFile')}
              <input type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" hidden
                onChange={(e) => { openFile(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          </div>

          <div className="field">
            <span>{t('groupMeaning.title')}</span>
            <div className="copymap__type-group">
              {GROUP_MEANINGS.map((m) => (
                <button key={m} type="button"
                  className={`copymap__type-btn${meaning === m ? ' copymap__type-btn--active' : ''}`}
                  onClick={() => setMeaning(m)}>
                  {t(`groupMeaning.${m}`)}
                </button>
              ))}
            </div>
            <small className="map-sidebar__hint">{t(`importSystems.meaningHint.${meaning}`)}</small>
          </div>

          {text.trim() && !table && <div className="map-sidebar__hint map-sidebar__hint--error">{t('importSystems.noHeader')}</div>}
          {lookupFailed && <div className="map-sidebar__hint map-sidebar__hint--error">{t('importSystems.lookupFailed')}</div>}
          {waiting && <div className="map-sidebar__hint">{t('importSystems.checking')}</div>}

          {rows.length > 0 && (
            <>
              <div className="map-sidebar__hint">
                {t('importSystems.summary', { good: good.length, bad: rows.length - good.length })}
              </div>
              <div className={styles.preview}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>#</th><th>{t('importSystems.col.system')}</th><th>{t('importSystems.col.signature')}</th>
                      <th>{t('importSystems.col.toSystem')}</th><th>{t('importSystems.col.check')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.line}>
                        <td>{r.line}</td>
                        <td>{r.system}</td>
                        <td>{r.signature}</td>
                        <td>{r.toSystem}</td>
                        {r.errors.length
                          ? <td className={styles.bad}>{r.errors.map((e) => t(`importSystems.error.${e}`)).join(' ')}</td>
                          : <td className={styles.ok}>{t('importSystems.rowOk')}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {plan.notPaths.length > 0 && (
                <div className="map-sidebar__hint">{t('importSystems.notPaths', { groups: plan.notPaths.join(', ') })}</div>
              )}
            </>
          )}

          <div className="modal__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>{t('actions.cancel')}</button>
            <button type="button" className="btn btn--primary" onClick={run} disabled={!good.length || busy || waiting}>
              {busy ? t('importSystems.importing') : t('importSystems.import', { count: good.length })}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
