import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { timeAgo } from '../../i18n/format';
import { useMapStore } from '../../store/mapStore';
import { scanUrl, type SystemScanEntry } from '../../utils/dscanView';
import styles from './Dscan.module.css';

/**
 * Scans pinned to this system in the last day, newest first. Re-reads when
 * anyone on the map pins another (the live stream bumps dscanRev).
 */
export function DscanSystemList({ mapId, eveSystemId }: { mapId: string; eveSystemId: number }) {
  const { t } = useTranslation();
  const rev = useMapStore((s) => s.dscanRev[eveSystemId] ?? 0);
  const [scans, setScans] = useState<SystemScanEntry[] | null>(null);

  useEffect(() => {
    let live = true;
    api<SystemScanEntry[]>(`/api/dscan/map/${mapId}/system/${eveSystemId}`)
      .then((list) => { if (live) setScans(list); })
      .catch(() => { if (live) setScans([]); });
    return () => { live = false; };
  }, [mapId, eveSystemId, rev]);

  if (scans == null) return null;
  if (scans.length === 0) return <span className={styles.empty}>{t('dscan.systemNone')}</span>;

  return (
    <ul className={styles.sysList}>
      {scans.map((s) => (
        <li key={s.id} className={styles.sysItem}>
          <a className={styles.sysLink} href={scanUrl(s.id)} target="_blank" rel="noopener noreferrer">
            {s.summary.kind === 'local'
              ? t('dscan.summaryLocal', { n: s.summary.pilots })
              : t('dscan.summaryDscan', { ships: s.summary.ships, total: s.summary.total })}
          </a>
          <span className={styles.sysAgo}>{timeAgo(t, new Date(s.createdAt))}</span>
        </li>
      ))}
    </ul>
  );
}
