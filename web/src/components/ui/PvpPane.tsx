import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { useNow30s } from '../../hooks/useNow30s';
import { useUserSetting } from '../../hooks/useUserSetting';
import { heatColor } from '../../utils/heatmap';
import {
  forecastBars, nextBusiest, resolveZone, zonedTime, zonedWeekday, allZones, type PvpForecastData,
} from '../../utils/pvpForecast';
import styles from './PvpPane.module.css';

const REFRESH_MS = 10 * 60 * 1000;
const TICKS = [0, 6, 12, 18, 24];

/**
 * When a system tends to see fights: its kills by UTC weekday and hour over
 * zKillboard's last 90 days, laid out as the next 24 hours from now. Hotter
 * bars are hours that are usually busier; the headline names the busiest one
 * ahead, and the live (R2Z2) feed adds what's happened in the last day.
 */
export function PvpPane({ eveSystemId }: { eveSystemId: number | null }) {
  const { t, i18n } = useTranslation();
  const now = useNow30s();
  const [colorVision] = useUserSetting<string>('nexum.a11y.colorVision', 'off');
  // Which timezone the times are shown in: the browser's own by default.
  const [zoneSetting, setZoneSetting] = useUserSetting<string>('nexum.timeZone', 'auto');
  const zones = useMemo(() => allZones(), []);
  // Tagged with the system it belongs to, so switching systems reads as
  // loading straight away rather than showing the last one's bars.
  const [state, setState] = useState<{ id: number; data: PvpForecastData | null } | null>(null);

  useEffect(() => {
    if (!eveSystemId) return;
    let live = true;
    const load = () =>
      api<PvpForecastData>(`/api/activity/pvp/${eveSystemId}`)
        .then((data) => { if (live) setState({ id: eveSystemId, data }); })
        .catch(() => { if (live) setState((s) => s?.id === eveSystemId && s.data ? s : { id: eveSystemId, data: null }); });
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { live = false; clearInterval(timer); };
  }, [eveSystemId]);

  const current = state?.id === eveSystemId ? state : null;
  const data = current?.data ?? null;
  const bars = useMemo(() => (data ? forecastBars(data.grid, now) : []), [data, now]);

  if (!eveSystemId) return <div className="sig-pane__empty">{t('panes.noEveSystem')}</div>;
  if (!current) return <div className="sig-pane__empty">{t('pvp.loading')}</div>;
  if (!data) return <div className="sig-pane__empty">{t('pvp.loadFailed')}</div>;

  const recent = data.recent24h > 0
    ? <span className={styles.recent}>{t('pvp.recent', { n: data.recent24h.toLocaleString() })}</span>
    : null;

  if (data.total === 0) {
    return (
      <div className={styles.pane}>
        <span className="sig-pane__empty">
          {data.days > 0 ? t('pvp.noneInDays', { count: data.days }) : t('pvp.noHistory')}
        </span>
        {recent}
      </div>
    );
  }

  const busiest = nextBusiest(bars);
  const cvd = colorVision !== 'off';
  const lang = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const zone = resolveZone(zoneSetting);
  const localZone = resolveZone('auto');
  return (
    <div className={styles.pane}>
      <div className={styles.head}>
        <span className={styles.headline}>
          {busiest
            ? (busiest.offset === 0
              ? t('pvp.busiestNow', { time: zonedTime(busiest.startMs, zone, lang) })
              : t('pvp.busiestNext', { time: zonedTime(busiest.startMs, zone, lang), n: busiest.offset }))
            : t('pvp.quietAhead')}
        </span>
        <span className={styles.total}>{t('pvp.killsInDays', { n: data.total.toLocaleString(), days: data.days })}</span>
      </div>
      <div className={styles.bars} role="img" aria-label={t('pvp.chartLabel')}>
        {bars.map((b) => (
          <span
            key={b.offset}
            className={`${styles.bar}${b.offset === 0 ? ` ${styles.barNow}` : ''}`}
            style={b.kills > 0 ? { background: heatColor(b.level, cvd), opacity: 0.35 + 0.65 * b.level } : undefined}
            title={t('pvp.barTitle', {
              day: zonedWeekday(b.startMs, zone, lang), time: zonedTime(b.startMs, zone, lang), n: b.kills.toLocaleString(),
            })}
          />
        ))}
      </div>
      <div className={styles.ticks}>
        {TICKS.map((h) => <span key={h}>{h === 0 ? t('pvp.now') : `+${h}h`}</span>)}
      </div>
      {recent}
      <span className={styles.note}>{data.source === 'zkill' ? t('pvp.noteZkill') : t('pvp.noteLive')}</span>
      <label className={styles.zone}>
        <span>{t('pvp.timesIn')}</span>
        <select value={zoneSetting} onChange={(e) => setZoneSetting(e.target.value)}>
          <option value="auto">{t('pvp.zoneAuto', { zone: localZone })}</option>
          <option value="UTC">{t('pvp.zoneUtc')}</option>
          {zones.filter((z) => z !== 'UTC').map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
        </select>
      </label>
    </div>
  );
}
