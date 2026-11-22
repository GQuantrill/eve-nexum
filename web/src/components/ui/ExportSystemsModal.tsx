import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '../../icons';
import { api } from '../../api/client';
import { toast } from '../../utils/toastStore';
import { saveFile } from '../../utils/saveFile';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { exportRows, toDelimited, toJson, type Clip } from '../../utils/selectionExport';

// Export the selected systems as CSV, TSV or JSON rows (utils/selectionExport.ts),
// to copy into a spreadsheet or another mapper, or to save as a file.

type Format = 'csv' | 'tsv' | 'json';
const FORMATS: Format[] = ['csv', 'tsv', 'json'];
const MIME: Record<Format, string> = { csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json' };

interface Props { mapId: string; systemIds: string[]; onClose: () => void }

export function ExportSystemsModal({ mapId, systemIds, onClose }: Props) {
  useEscapeClose(onClose);
  const { t } = useTranslation();
  const [clip, setClip] = useState<Clip | null>(null);
  const [error, setError] = useState(false);
  const [format, setFormat] = useState<Format>('csv');
  const [skipLocked, setSkipLocked] = useState(false);

  useEffect(() => {
    let live = true;
    api<Clip>(`/api/maps/${mapId}/clip`, { method: 'POST', body: JSON.stringify({ systemIds }) })
      .then((c) => { if (live) setClip(c); })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [mapId, systemIds]);

  const rows = useMemo(() => (clip ? exportRows(clip, skipLocked) : []), [clip, skipLocked]);
  const text = format === 'json' ? toJson(rows) : toDelimited(rows, format === 'csv' ? ',' : '\t');
  const lockedCount = clip?.systems.filter((s) => s.locked).length ?? 0;

  const copy = () => {
    navigator.clipboard?.writeText(text)
      .then(() => { toast.success(t('exportSystems.copied')); onClose(); })
      .catch(() => toast.error(t('exportSystems.copyFailed')));
  };
  const save = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    void saveFile(`nexum_systems_${stamp}.${format}`, new Blob([text], { type: MIME[format] }));
    onClose();
  };

  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal__header">
          <h2 className="modal__title">{t('exportSystems.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={16} weight="bold" />
          </button>
        </div>

        <div className="modal__body">
          <div className="field">
            <span>{t('exportSystems.format')}</span>
            <div className="copymap__type-group">
              {FORMATS.map((f) => (
                <button key={f} type="button"
                  className={`copymap__type-btn${format === f ? ' copymap__type-btn--active' : ''}`}
                  onClick={() => setFormat(f)}>
                  {t(`exportSystems.formats.${f}`)}
                </button>
              ))}
            </div>
          </div>

          <label className="map-sidebar__row map-sidebar__toggle-row">
            <span className="map-sidebar__label">{t('exportSystems.skipLocked', { count: lockedCount })}</span>
            <input type="checkbox" className="map-sidebar__toggle-input" disabled={lockedCount === 0}
              checked={skipLocked} onChange={(e) => setSkipLocked(e.target.checked)} />
          </label>

          <div className="map-sidebar__hint">
            {error ? t('exportSystems.loadFailed')
              : clip ? t('exportSystems.summary', { systems: clip.systems.length - (skipLocked ? lockedCount : 0), rows: rows.length })
                : t('exportSystems.loading')}
          </div>

          <div className="modal__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose}>{t('actions.cancel')}</button>
            <button type="button" className="btn btn--ghost" onClick={copy} disabled={!clip || !rows.length}>
              {t('exportSystems.copy')}
            </button>
            <button type="button" className="btn btn--primary" onClick={save} disabled={!clip || !rows.length}>
              {t('exportSystems.save')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
