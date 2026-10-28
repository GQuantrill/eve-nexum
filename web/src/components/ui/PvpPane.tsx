import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { useNow30s } from '../../hooks/useNow30s';
import { useUserSetting } from '../../hooks/useUserSetting';
import { heatColor } from '../../utils/heatmap';
import { forecastBars, nextBusiest, utcHourLabel, type PvpForecastData } from '../../utils/pvpForecast';
import styles from './PvpPane.module.css';

const REFRESH_MS = 10 * 60 * 1000;
const TICKS = [0, 6, 12, 18, 24];

/**
 * When a system tends to see fights: its player kills by UTC hour of day over
 * the server's history window, laid out as the next 24 hours from now. Hotter
 * bars had more kills at that hour; the headline names the busiest one ahead.
 */
export function PvpPane({ eveSystemId }: { eveSystemId: number | null }) {
  const { t } = useTranslation();
  const now = useNow30s();
  const [colorVision] = useUserSetting<string>('nexum.a11y.colorVision', 'off');
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
  const bars = useMemo(() => (data ? forecastBars(data.byHour, now) : []), [data, now]);

  if (!eveSystemId) return <div className="sig-pane__empty">{t('panes.noEveSystem')}</div>;
  if (!current) return <div className="sig-pane__empty">{t('pvp.loading')}</div>;
  if (!current.data) return <div className="sig-pane__empty">{t('pvp.loadFailed')}</div>;

  const { total, days } = current.data;
  if (total === 0) {
    return <div className="sig-pane__empty">{days > 0 ? t('pvp.noneInDays', { days }) : t('pvp.noHistory')}</div>;
  }

  const busiest = nextBusiest(bars);
  const cvd = colorVision !== 'off';
  return (
    <div className={styles.pane}>
      <div className={styles.head}>
        <span className={styles.headline}>
          {busiest && (busiest.offset === 0
            ? t('pvp.busiestNow', { hour: utcHourLabel(busiest.hour) })
            : t('pvp.busiestNext', { hour: utcHourLabel(busiest.hour), n: busiest.offset }))}
        </span>
        <span className={styles.total}>{t('pvp.killsInDays', { n: total.toLocaleString(), days })}</span>
      </div>
      <div className={styles.bars} role="img" aria-label={t('pvp.chartLabel')}>
        {bars.map((b) => (
          <span
            key={b.offset}
            className={`${styles.bar}${b.offset === 0 ? ` ${styles.barNow}` : ''}`}
            style={b.kills > 0 ? { background: heatColor(b.level, cvd), opacity: 0.35 + 0.65 * b.level } : undefined}
            title={t('pvp.barTitle', { hour: utcHourLabel(b.hour), n: b.kills.toLocaleString() })}
          />
        ))}
      </div>
      <div className={styles.ticks}>
        {TICKS.map((h) => <span key={h}>{h === 0 ? t('pvp.now') : `+${h}h`}</span>)}
      </div>
      <span className={styles.note}>{t('pvp.note')}</span>
    </div>
  );
}
