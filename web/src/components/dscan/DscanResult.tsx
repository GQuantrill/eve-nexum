import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { timeAgo, expiresIn, mass } from '../../i18n/format';
import { toast } from '../../utils/toastStore';
import { useNow30s } from '../../hooks/useNow30s';
import {
  breakdown, localBreakdown, scanUrl,
  type DscanData, type DscanSection, type GridFilter, type LocalData, type StoredScan,
} from '../../utils/dscanView';
import styles from './Dscan.module.css';

const AU_KM = 149_597_870.7;

/** Distances as the d-scan window shows them: km up close, AU further out. */
function formatDistance(km: number | null): string {
  if (km == null) return '-';
  if (km >= AU_KM / 10) return `${(km / AU_KM).toFixed(1)} AU`;
  return `${Math.round(km).toLocaleString()} km`;
}

/** The link to pass round, with copy and open buttons. */
export function ScanLinkBar({ id, openInNewTab = false }: { id: string; openInNewTab?: boolean }) {
  const { t } = useTranslation();
  const url = scanUrl(id);
  const copy = () => {
    navigator.clipboard.writeText(url).then(
      () => toast.success(t('dscan.linkCopied')),
      () => toast.error(t('dscan.copyFailed')),
    );
  };
  return (
    <div className={styles.linkBar}>
      <input className={styles.linkField} value={url} readOnly onFocus={(e) => e.currentTarget.select()} aria-label={t('dscan.shareLink')} />
      <button type="button" className="btn btn--primary" onClick={copy}>{t('dscan.copyLink')}</button>
      {openInNewTab && (
        <a className="btn btn--ghost" href={url} target="_blank" rel="noopener noreferrer">{t('dscan.openInNewTab')}</a>
      )}
    </div>
  );
}

export function DscanResult({ scan }: { scan: StoredScan }) {
  const { t } = useTranslation();
  const now = useNow30s();
  const created = new Date(scan.createdAt).getTime();
  const expires = new Date(scan.expiresAt).getTime();
  return (
    <div className={styles.result}>
      <div className={styles.meta}>
        {scan.data.system && <span className={styles.system}>{scan.data.system.name}</span>}
        <span className={styles.kind}>{scan.data.kind === 'local' ? t('dscan.kindLocal') : t('dscan.kindDscan')}</span>
        <span title={new Date(created).toLocaleString()}>{t('dscan.scanned', { ago: timeAgo(t, created) })}</span>
        <span>{expiresIn(t, expires - now)}</span>
      </div>
      {scan.data.kind === 'local' ? <LocalView data={scan.data} /> : <DscanView data={scan.data} />}
    </div>
  );
}

const SECTION_ORDER: DscanSection[] = ['ship', 'structure', 'deployable', 'drone', 'other'];
const SECTION_KEY = {
  ship:       'dscan.sections.ships',
  structure:  'dscan.sections.structures',
  deployable: 'dscan.sections.deployables',
  drone:      'dscan.sections.drones',
  other:      'dscan.sections.other',
} as const;

function DscanView({ data }: { data: DscanData }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<GridFilter>('all');
  const b = useMemo(() => breakdown(data, filter), [data, filter]);

  // Structures and deployables are few and are identified by NAME (whose
  // citadel, which depot), so those list each item; ships and the rest are
  // counted by type.
  const itemsBySection = useMemo(() => {
    const out: Partial<Record<DscanSection, Array<{ name: string; type: string; dist: number | null }>>> = {};
    for (const [typeId, name, dist] of data.rows) {
      const info = data.types[typeId];
      if (!info || (info.s !== 'structure' && info.s !== 'deployable')) continue;
      const on = dist != null && dist <= data.onGridKm;
      if ((filter === 'on' && !on) || (filter === 'off' && on)) continue;
      (out[info.s] ??= []).push({ name, type: info.n, dist });
    }
    for (const list of Object.values(out)) list?.sort((a, b2) => (a.dist ?? Infinity) - (b2.dist ?? Infinity));
    return out;
  }, [data, filter]);

  const filters: Array<[GridFilter, string, number]> = [
    ['all', t('dscan.filterAll'), b.onGrid + b.offGrid],
    ['on',  t('dscan.filterOnGrid'), b.onGrid],
    ['off', t('dscan.filterOffGrid'), b.offGrid],
  ];

  return (
    <>
      <div className={styles.filters} role="group" aria-label={t('dscan.filterLabel')}>
        {filters.map(([f, label, n]) => (
          <button
            key={f}
            type="button"
            className={`${styles.filter}${filter === f ? ` ${styles.filterOn}` : ''}`}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {label}<span className={styles.count}>{n}</span>
          </button>
        ))}
      </div>
      <span className={styles.hint}>{t('dscan.onGridHint', { km: data.onGridKm.toLocaleString() })}</span>

      <div className={styles.stats}>
        <Stat label={t('dscan.sections.ships')} value={b.sectionTotals.ship} />
        <Stat
          label={t('dscan.hullMass')}
          value={b.shipMass > 0 ? mass(t, b.shipMass) : '-'}
          note={b.shipsWithoutMass > 0 ? t('dscan.noMassData', { n: b.shipsWithoutMass }) : undefined}
        />
        <Stat label={t('dscan.sections.structures')} value={b.sectionTotals.structure} />
        <Stat label={t('dscan.sections.deployables')} value={b.sectionTotals.deployable} />
        <Stat label={t('dscan.sections.drones')} value={b.sectionTotals.drone} />
        <Stat label={t('dscan.total')} value={b.total} />
      </div>

      {b.total === 0 && <p className={styles.empty}>{t('dscan.nothingInRange')}</p>}

      {SECTION_ORDER.map((s) => {
        if (b.sectionTotals[s] === 0) return null;
        const items = itemsBySection[s];
        return (
          // Each section folds away on its own, so a scan full of structures
          // doesn't bury the ships (or the other way round).
          <details key={s} className={styles.section} open>
            <summary className={styles.sectionTitle}>
              {t(SECTION_KEY[s])}<span className={styles.count}>{b.sectionTotals[s]}</span>
            </summary>
            <div className={styles.sectionBody}>
            {items ? (
              <ul className={`${styles.rows} ${styles.flatRows}`}>
                {items.map((it, i) => (
                  <li key={i} className={styles.row}>
                    <span className={styles.rowName}>{it.name || it.type}</span>
                    <span className={styles.dist}>{it.type}</span>
                    <span className={styles.dist}>{formatDistance(it.dist)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              b.sections[s].map((g) => (
                <details key={g.group} className={styles.group} open={s === 'ship' && b.sections[s].length <= 6}>
                  <summary>
                    <span className={styles.groupName}>{g.group || t('dscan.unknownGroup')}</span>
                    <span className={styles.num}>{g.count}</span>
                  </summary>
                  <ul className={styles.rows}>
                    {g.types.map((ty) => (
                      <li key={ty.typeId} className={styles.row}>
                        <span className={styles.rowName}>{ty.name}</span>
                        <span className={styles.num}>{ty.count}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ))
            )}
            </div>
          </details>
        );
      })}
    </>
  );
}

function LocalView({ data }: { data: LocalData }) {
  const { t } = useTranslation();
  const alliances = useMemo(() => localBreakdown(data), [data]);
  return (
    <>
      <div className={styles.stats}>
        <Stat label={t('dscan.pilots')} value={data.pilots.length} />
        <Stat label={t('dscan.alliances')} value={alliances.filter((a) => a.id != null).length} />
        <Stat label={t('dscan.corps')} value={new Set(data.pilots.map((p) => p.c)).size} />
        {data.unknown.length > 0 && <Stat label={t('dscan.notFound')} value={data.unknown.length} />}
      </div>

      <section className={styles.section}>
        {alliances.map((a) => (
          <details key={a.id ?? 'none'} className={styles.group} open={alliances.length <= 4}>
            <summary>
              <span className={styles.groupName}>{a.id == null ? t('dscan.noAlliance') : a.name}</span>
              <span className={styles.num}>{a.count}</span>
            </summary>
            <ul className={styles.rows}>
              {a.corps.map((c) => (
                <li key={c.id ?? 'none'} className={styles.row}>
                  <span className={styles.rowName}>{c.name || t('dscan.unknownGroup')}</span>
                  <span className={styles.num}>{c.count}</span>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </section>

      {data.unknown.length > 0 && (
        <details className={styles.group}>
          <summary>
            <span className={styles.groupName}>{t('dscan.notFoundHint')}</span>
            <span className={styles.num}>{data.unknown.length}</span>
          </summary>
          <ul className={styles.rows}>
            {data.unknown.map((n) => <li key={n} className={styles.row}><span className={styles.rowName}>{n}</span></li>)}
          </ul>
        </details>
      )}
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
      {note && <span className={styles.statNote}>{note}</span>}
    </div>
  );
}
