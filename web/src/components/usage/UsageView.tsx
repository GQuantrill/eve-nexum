import { useTranslation } from 'react-i18next';
import styles from './Usage.module.css';

// The usage figures (server: services/usageStats.ts), shown in the admin
// Reports tab and on the public page behind the shareable link.

export interface UsageMonth {
  month: string;
  liveGa: number | null;
  liveSignedIn: number | null;
  selfHosted: number;
  selfHostedInstances: number;
}

export interface UsageReport {
  generatedAt: string;
  gaConnected: boolean;
  current: {
    liveGa30d: number | null;
    liveSignedIn30d: number | null;
    selfHosted30d: number;
    selfHostedAccounts30d: number;
    selfHostedInstances: number;
    instancesWithoutCounts: number;
    desktop30d: number;
    total30d: number;
  };
  months: UsageMonth[];
  breakdown: {
    modes: Record<string, number>;
    versions: Record<string, number>;
    languages: Record<string, number>;
    features: Record<string, number>;
  };
}

type Feature = 'chainNumbering' | 'autoRemove' | 'crossMapSync' | 'discord';
const FEATURES: Feature[] = ['chainNumbering', 'autoRemove', 'crossMapSync', 'discord'];
type Mode = 'solo' | 'corp' | 'alliance';
const MODES: Mode[] = ['solo', 'corp', 'alliance'];

const LANG_NAMES: Record<string, string> = {
  en: 'English', de: 'Deutsch', nl: 'Nederlands', fr: 'Français', es: 'Español',
  pt: 'Português', zh: '中文', ko: '한국어', ja: '日本語', ru: 'Русский',
};

/** This site's figure for a month: Analytics when connected, else signed-in pilots. */
const liveOf = (m: UsageMonth) => m.liveGa ?? m.liveSignedIn ?? 0;

export function UsageView({ report }: { report: UsageReport }) {
  const { t, i18n } = useTranslation();
  const n = (v: number) => v.toLocaleString(i18n.language);
  const monthLabel = (ym: string) =>
    new Date(`${ym}-01T00:00:00Z`).toLocaleDateString(i18n.language, { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const c = report.current;
  const live30d = c.liveGa30d ?? c.liveSignedIn30d ?? 0;
  const max = Math.max(1, ...report.months.map((m) => liveOf(m) + m.selfHosted));
  const versions = Object.entries(report.breakdown.versions).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const languages = Object.entries(report.breakdown.languages).sort((a, b) => b[1] - a[1]);

  return (
    <div className={styles.view}>
      <p className={styles.updated}>
        {t('usage.updated', { time: new Date(report.generatedAt).toLocaleString(i18n.language) })}
      </p>

      <div className={styles.tiles}>
        <div className={`${styles.tile} ${styles.tileMain}`}>
          <span className={styles.tileLabel}>{t('usage.kpi.total')}</span>
          <span className={styles.tileValue}>{n(c.total30d)}</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileLabel}><i className={styles.swatchLive} />{t('usage.kpi.live')}</span>
          <span className={styles.tileValue}>{n(live30d)}</span>
          <span className={styles.tileNote}>{c.liveGa30d != null ? t('usage.kpi.liveGaNote') : t('usage.kpi.liveSignedInNote')}</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileLabel}><i className={styles.swatchSelf} />{t('usage.kpi.selfHosted')}</span>
          <span className={styles.tileValue}>{n(c.selfHosted30d)}</span>
          <span className={styles.tileNote}>{t('usage.kpi.installs', { count: c.selfHostedInstances })}</span>
        </div>
        <div className={styles.tile}>
          <span className={styles.tileLabel}>{t('usage.kpi.desktop')}</span>
          <span className={styles.tileValue}>{n(c.desktop30d)}</span>
          <span className={styles.tileNote}>{t('usage.kpi.desktopNote')}</span>
        </div>
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{t('usage.chart.title')}</h2>
          <span className={styles.legend}>
            <span><i className={styles.swatchLive} />{t('usage.kpi.live')}</span>
            <span><i className={styles.swatchSelf} />{t('usage.kpi.selfHosted')}</span>
          </span>
        </div>
        <div className={styles.chart} role="img" aria-label={t('usage.chart.title')}>
          {report.months.map((m) => {
            const live = liveOf(m);
            const total = live + m.selfHosted;
            return (
              <div key={m.month} className={styles.col} data-tooltip={`${monthLabel(m.month)}: ${n(total)}`}>
                <span className={styles.colValue}>{total ? n(total) : ''}</span>
                <div className={styles.bar} style={{ height: `${(total / max) * 100}%` }}>
                  <div className={styles.barSelf} style={{ flexGrow: m.selfHosted }} />
                  <div className={styles.barLive} style={{ flexGrow: live }} />
                </div>
                <span className={styles.colLabel}>{monthLabel(m.month)}</span>
              </div>
            );
          })}
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('usage.table.month')}</th>
                {report.gaConnected && <th>{t('usage.table.live')}</th>}
                <th>{t('usage.table.signedIn')}</th>
                <th>{t('usage.table.selfHosted')}</th>
                <th>{t('usage.table.installs')}</th>
                <th>{t('usage.table.total')}</th>
              </tr>
            </thead>
            <tbody>
              {[...report.months].reverse().map((m) => (
                <tr key={m.month}>
                  <td>{monthLabel(m.month)}</td>
                  {report.gaConnected && <td>{m.liveGa != null ? n(m.liveGa) : '-'}</td>}
                  <td>{m.liveSignedIn != null ? n(m.liveSignedIn) : '-'}</td>
                  <td>{n(m.selfHosted)}</td>
                  <td>{n(m.selfHostedInstances)}</td>
                  <td className={styles.totalCell}>{n(liveOf(m) + m.selfHosted)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>{t('usage.breakdown.title')}</h2>
        <div className={styles.lists}>
          <Breakdown title={t('usage.breakdown.modes')}
            rows={MODES.map((m) => [t(`usage.modes.${m}`), report.breakdown.modes[m] ?? 0])} n={n} />
          <Breakdown title={t('usage.breakdown.versions')} rows={versions} n={n} />
          <Breakdown title={t('usage.breakdown.languages')}
            rows={languages.map(([k, v]) => [LANG_NAMES[k] ?? k, v])} n={n} />
          <Breakdown title={t('usage.breakdown.features')}
            rows={FEATURES.map((f) => [t(`usage.features.${f}`), report.breakdown.features[f] ?? 0])} n={n} />
        </div>
      </section>

      <section className={styles.notes}>
        <h2 className={styles.cardTitle}>{t('usage.notes.title')}</h2>
        <p>{t('usage.notes.live')}</p>
        <p>{t('usage.notes.selfHosted')}</p>
        {!report.gaConnected && <p>{t('usage.notes.noGa')}</p>}
        {c.instancesWithoutCounts > 0 && <p>{t('usage.notes.old', { count: c.instancesWithoutCounts })}</p>}
      </section>
    </div>
  );
}

function Breakdown({ title, rows, n }: { title: string; rows: Array<[string, number]>; n: (v: number) => string }) {
  return (
    <div>
      <h3 className={styles.listTitle}>{title}</h3>
      <ul className={styles.list}>
        {rows.length === 0 && <li className={styles.listEmpty}>-</li>}
        {rows.map(([k, v]) => <li key={k}><span>{k}</span><span>{n(v)}</span></li>)}
      </ul>
    </div>
  );
}
