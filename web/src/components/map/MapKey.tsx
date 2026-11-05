import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMapStore } from '../../store/mapStore';
import { hoursMins } from '../../i18n/format';
import { FlagBannerIcon, XIcon } from '../../icons';
import styles from './MapKey.module.css';

// What every look a connection can take means. Swatches use the same colour
// tokens, dashes and label classes as ConnectionEdge, so the key follows the
// colour-vision palette and can't drift from the map it explains.

interface LineProps {
  color: string;
  dash?: string;
  core?: string;
  glow?: string;
}

function Line({ color, dash, core, glow }: LineProps) {
  return (
    <svg className={styles.line} viewBox="0 0 48 12" aria-hidden="true">
      <line x1="3" y1="6" x2="45" y2="6" stroke={color} strokeWidth="4" strokeDasharray={dash}
        style={glow ? { filter: `drop-shadow(0 0 3px ${glow}) drop-shadow(0 0 1px ${glow})` } : undefined} />
      {core && <line x1="3" y1="6" x2="45" y2="6" stroke={core} strokeWidth="1.5" strokeLinecap="round" />}
    </svg>
  );
}

function Row({ swatch, label, children }: { swatch: ReactNode; label?: ReactNode; children: ReactNode }) {
  return (
    <li className={styles.row}>
      <span className={styles.swatch}>{swatch}{label}</span>
      <span className={styles.text}>{children}</span>
    </li>
  );
}

const C = {
  standard: 'var(--cv-conn-standard)',
  h4:       'var(--cv-conn-4h)',
  h1:       'var(--cv-conn-1h)',
  expired:  'var(--cv-conn-expired)',
  gate:     'var(--cv-conn-gate)',
  jumpgate: 'var(--cv-conn-jumpgate)',
  cyno:     'var(--cv-conn-cyno)',
  highlight: 'var(--cv-conn-highlight)',
};

export function MapKey({ onClose, side }: { onClose: () => void; side: 'left' | 'right' }) {
  const { t } = useTranslation();
  const lazyRemove = useMapStore((s) => !!s.map.lazyRemoveWormholes);
  const graceHours = useMapStore((s) => s.map.collapseGraceHours ?? 0.5);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // What happens next to an expired hole depends on this map's settings.
  const afterExpiry = !lazyRemove
    ? t('mapKey.expiredKept')
    : graceHours <= 0
      ? t('mapKey.expiredCutNow')
      : t('mapKey.expiredCutAfter', { time: hoursMins(graceHours * 3_600_000) });

  return (
    <div className={`${styles.panel} ${side === 'right' ? styles.right : styles.left}`}
      role="dialog" aria-label={t('mapKey.title')}>
      <div className={styles.head}>
        <span className={styles.title}>{t('mapKey.title')}</span>
        <button type="button" className={styles.close} onClick={onClose} aria-label={t('mapKey.close')}>
          <XIcon size={14} weight="bold" />
        </button>
      </div>
      <div className={styles.body}>
        <h4 className={styles.section}>{t('mapKey.lifetime')}</h4>
        <ul className={styles.list}>
          <Row swatch={<Line color={C.standard} />}>{t('mapKey.fresh')}</Row>
          <Row swatch={<Line color={C.standard} />} label={<span className="connection-label__eol">{t('mapEdge.lessThan24h')}</span>}>
            {t('mapKey.lessThan24h')}
          </Row>
          <Row swatch={<Line color={C.h4} />} label={<span className="connection-label__eol">2h 10m</span>}>
            {t('mapKey.lessThan4h')}
          </Row>
          <Row swatch={<Line color={C.h1} />} label={<span className="connection-label__eol">40m</span>}>
            {t('mapKey.lessThan1h')}
          </Row>
          <Row swatch={<Line color={C.expired} />} label={<span className="connection-label__crit">!</span>}>
            {t('mapKey.expired')} {afterExpiry}
          </Row>
          <Row swatch={<Line color={C.expired} dash="5 7" />} label={<span className={styles.scissors}>&#9986;</span>}>
            {t('mapKey.broken')}
          </Row>
        </ul>

        <h4 className={styles.section}>{t('mapKey.massSize')}</h4>
        <ul className={styles.list}>
          <Row swatch={<Line color={C.standard} />} label={<span className="connection-label__type">C140<span className="connection-label__size">XL</span></span>}>
            {t('mapKey.type')}
          </Row>
          <Row swatch={<Line color={C.standard} dash="4 4" />} label={<span className="connection-label__type">WH<span className="connection-label__size connection-label__size--limit">S</span></span>}>
            {t('mapKey.frigate')}
          </Row>
          <Row swatch={<Line color={C.standard} />} label={<span className="connection-label__mass">&gt; 50%</span>}>
            {t('mapKey.massStable')}
          </Row>
          <Row swatch={<Line color={C.standard} core={C.h1} />} label={<span className="connection-label__mass connection-label__mass--warn">&lt; 50%</span>}>
            {t('mapKey.massHalf')}
          </Row>
          <Row swatch={<Line color={C.standard} core={C.expired} />} label={<span className="connection-label__mass connection-label__mass--crit">&lt; 10%</span>}>
            {t('mapKey.massCritical')}
          </Row>
        </ul>

        <h4 className={styles.section}>{t('mapKey.other')}</h4>
        <ul className={styles.list}>
          <Row swatch={<Line color={C.gate} />} label={<span className="connection-label__gate">G</span>}>
            {t('mapKey.gate')}
          </Row>
          <Row swatch={<Line color={C.jumpgate} dash="10 5" />} label={<span className="connection-label__jumpgate">JG</span>}>
            {t('mapKey.jumpgate')}
          </Row>
          <Row swatch={<Line color={C.cyno} dash="2 6" />} label={<span className="connection-label__cyno">CJ 4.2ly</span>}>
            {t('mapKey.cyno')}
          </Row>
          <Row swatch={<Line color={C.standard} glow={C.h4} />}>{t('mapKey.watch')}</Row>
          <Row swatch={<Line color={C.standard} />} label={<span className="connection-label__flag"><FlagBannerIcon size={12} weight="fill" /></span>}>
            {t('mapKey.flag')}
          </Row>
          <Row swatch={<Line color={C.highlight} />}>{t('mapKey.highlight')}</Row>
        </ul>
      </div>
    </div>
  );
}
