import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '../../icons';
import { useMapStore } from '../../store/mapStore';
import { useCanEditContent } from '../../hooks/useCanEditContent';
import { DscanPaste, type ScanAttachTarget } from './DscanPaste';
import { DscanResult, ScanLinkBar } from './DscanResult';
import { useScan } from '../../hooks/useScan';
import styles from './Dscan.module.css';

/**
 * The analyser opened from the map toolbar. Same paste box and breakdown as
 * the public page, plus the option to pin the scan to the selected system so
 * it shows in that system's panel for everyone on the map.
 */
export function DscanModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [scanId, setScanId] = useState<string | null>(null);
  const canEdit = useCanEditContent();
  const activeMapId = useMapStore((s) => s.activeMapId);
  const selected = useMapStore((s) => s.map.systems.find((sy) => sy.id === s.selectedSystemId));

  // Only a system that is a real EVE system can carry a scan: the pin is by
  // EVE id, and an unknown placeholder node has none.
  const attach: ScanAttachTarget | null = canEdit && activeMapId && selected?.eveSystemId
    ? { mapId: activeMapId, systemId: selected.id, systemName: selected.name }
    : null;

  const onCreated = (id: string, pinned: boolean) => {
    setScanId(id);
    // Our own pin doesn't echo back over the live stream, so refresh the
    // system's list here.
    if (pinned && selected?.eveSystemId) useMapStore.getState().bumpDscanRev(selected.eveSystemId);
  };

  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${styles.modal}`} role="dialog" aria-modal="true" aria-label={t('dscan.title')}>
        <div className="modal__header">
          <h2 className="modal__title">{t('dscan.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={16} weight="bold" />
          </button>
        </div>
        <div className={`modal__body ${styles.modalBody}`}>
          {scanId ? (
            <>
              <div className={styles.pasteActions}>
                <button type="button" className="btn btn--ghost" onClick={() => setScanId(null)}>{t('dscan.newScan')}</button>
              </div>
              <ScanLinkBar id={scanId} openInNewTab />
              <LoadedResult id={scanId} />
            </>
          ) : (
            <DscanPaste attach={attach} onCreated={onCreated} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function LoadedResult({ id }: { id: string }) {
  const { t } = useTranslation();
  const state = useScan(id);
  if (state.status === 'loading') return <p className={styles.empty}>{t('dscan.loading')}</p>;
  if (state.status === 'error') return <p className={styles.error}>{state.message}</p>;
  return <DscanResult scan={state.scan} />;
}
