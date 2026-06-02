import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FireIcon } from '@phosphor-icons/react';
import { useUserSetting } from '../../hooks/useUserSetting';
import { HEAT_METRICS, type HeatMetric } from '../../utils/heatmap';

/**
 * Toolbar heatmap control: an icon button that opens a small horizontal popover
 * with the heatmap-type selector and (when a metric is active) the intensity
 * slider. Backs the same settings the map reads (nexum.map.heatmap /
 * heatIntensity), so it's just a relocation of the old Map Options control.
 */
export function HeatmapMenu() {
  const { t } = useTranslation();
  const [metric, setMetric]       = useUserSetting<HeatMetric>('nexum.map.heatmap', 'none');
  const [intensity, setIntensity] = useUserSetting<number>('nexum.map.heatIntensity', 1);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const active = metric !== 'none';

  return (
    <div className="heatmap-menu" ref={wrapRef}>
      <button
        type="button"
        className={`toolbar__toggle toolbar__toggle--icon toolbar__toggle--prominent${active ? ' toolbar__toggle--on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-pressed={active}
        aria-expanded={open}
        data-tooltip={t('mapSidebar.heatmap')}
        aria-label={t('mapSidebar.heatmap')}
      >
        <FireIcon size={18} weight="regular" />
      </button>
      {open && (
        <div className="heatmap-menu__pop" role="menu">
          <label className="heatmap-menu__label" htmlFor="heatmap-metric-tb">{t('mapSidebar.heatmap')}</label>
          <select
            id="heatmap-metric-tb"
            className="heatmap-menu__select"
            value={metric}
            onChange={(e) => setMetric(e.target.value as HeatMetric)}
          >
            {HEAT_METRICS.map((m) => (
              <option key={m} value={m}>{t(`mapSidebar.heatmapOptions.${m}`)}</option>
            ))}
          </select>
          {active && (
            <>
              <label className="heatmap-menu__label" htmlFor="heatmap-intensity-tb">{t('mapSidebar.heatIntensity')}</label>
              <input
                id="heatmap-intensity-tb"
                type="range"
                min={0.25}
                max={3}
                step={0.25}
                value={intensity}
                onChange={(e) => setIntensity(parseFloat(e.target.value))}
                className="heatmap-menu__slider"
              />
              <button
                type="button"
                className="heatmap-menu__value"
                onClick={() => setIntensity(1)}
                title={t('mapSidebar.resetIntensity')}
              >
                {Math.round(intensity * 100)}%
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
