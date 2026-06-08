import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useWormholeTypes } from '../../hooks/useWormholeTypes';
import { CLASS_COLORS, CLASS_LABELS } from '../../data/wormholes';
import { mass } from '../../i18n/format';
import type { SystemClass } from '../../types';

interface Props {
  code: string | null | undefined;
  /** When `children` are provided the children become the hover trigger
   *  (popover shows on mouse-enter, hides on leave). When omitted, a small
   *  `ⓘ` button is rendered and opens the popover on click. */
  children?: ReactNode;
}

function classKey(raw: string | null | undefined): SystemClass | null {
  if (!raw) return null;
  const up = raw.toUpperCase();
  if (/^C\d+$/.test(up))                                    return up as SystemClass;
  if (up === 'HS' || up === 'LS' || up === 'NS')            return up as SystemClass;
  if (up === 'POCHVEN')                                     return 'Pochven' as SystemClass;
  if (up === 'THERA')                                       return 'Thera'   as SystemClass;
  if (up === 'DRIFTER')                                     return 'Drifter' as SystemClass;
  return null;
}

export function WHTypeInfo({ code, children }: Props) {
  const { t } = useTranslation();
  const types = useWormholeTypes();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const hoverMode = !!children;

  // Click-mode: dismiss on outside click / Escape
  useEffect(() => {
    if (!open || hoverMode) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, hoverMode]);

  if (!code) return hoverMode ? <>{children}</> : null;
  const spec = types[code.toUpperCase()];
  if (!spec) return hoverMode ? <>{children}</> : null;
  const dest = classKey(spec.dest);

  const popover = open && (
    <div className="wh-type-info__popover" role="dialog">
      <div className="wh-type-info__header">{code.toUpperCase()}</div>
      <div className="wh-type-info__row">
        <span className="wh-type-info__label">{t('whInfo.leadsTo')}</span>
        <span
          className="wh-type-info__value"
          style={dest ? { color: CLASS_COLORS[dest] } : undefined}
        >
          {dest ? CLASS_LABELS[dest] : (spec.dest ? spec.dest.toUpperCase() : '?')}
        </span>
      </div>
      <div className="wh-type-info__row">
        <span className="wh-type-info__label">{t('whInfo.lifetime')}</span>
        <span className="wh-type-info__value">{spec.lifetimeHours}h</span>
      </div>
      <div className="wh-type-info__row">
        <span className="wh-type-info__label">{t('whInfo.totalMass')}</span>
        <span className="wh-type-info__value">{mass(t, spec.totalMass)}</span>
      </div>
      <div className="wh-type-info__row">
        <span className="wh-type-info__label">{t('whInfo.maxJump')}</span>
        <span className="wh-type-info__value">{mass(t, spec.maxJumpMass)}</span>
      </div>
    </div>
  );

  if (hoverMode) {
    return (
      <span
        className="wh-type-info wh-type-info--inline"
        ref={ref}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {children}
        {popover}
      </span>
    );
  }

  return (
    <span className="wh-type-info" ref={ref}>
      <button
        type="button"
        className="wh-type-info__btn"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        aria-label={t('whInfo.infoAria', { code })}
        data-tooltip={t('whInfo.specTooltip', { code })}
      >
        ⓘ
      </button>
      {popover}
    </span>
  );
}
