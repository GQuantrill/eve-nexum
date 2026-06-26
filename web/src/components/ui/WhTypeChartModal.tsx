import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '@phosphor-icons/react';
import { CLASS_COLORS } from '../../data/wormholes';
import { WH_JUMP_MASS } from '../../utils/wormholeSize';
import type { SystemClass } from '../../types';
import {
  WH_CHART, RESPAWN_ORDER, SPAWN_ORDER, LEADS_ORDER, SHIP_ORDER, MASS_ORDER, LIFE_ORDER,
  type WhChartEntry, type Respawn, type ShipSize,
} from '../../data/whTypeChart';
import { useWormholeTypes } from '../../hooks/useWormholeTypes';

// The chart's ship-size column is derived live from the SDE per-jump cap
// (wormholeMaxJumpMass) so it can't drift from a CCP rebalance. Maps to the
// chart's five descriptive tiers; null when a code has no dogma (keeps the
// curated value).
function shipSizeFromSde(
  code: string,
  whTypes: Record<string, { maxJumpMass?: number } | undefined>,
): ShipSize | null {
  const m = whTypes[code.toUpperCase()]?.maxJumpMass;
  if (!m) return null;
  if (m >= WH_JUMP_MASS.capital) return 'up to Capital';
  if (m >= WH_JUMP_MASS.xl)      return 'up to Freighter';
  if (m >= WH_JUMP_MASS.large)   return 'up to Battleship';
  if (m >= WH_JUMP_MASS.medium)  return 'up to Battlecruiser';
  return 'up to Destroyer';
}

// A Nexum take on whtype.info: hover ANY cell — a wormhole code OR an attribute
// value — and lines connect a code to its values (or a value to every code that
// has it), with the matching cells highlighted.

interface Line { d: string; color: string; }

// Selection is either a wormhole code, or a value in one of the attribute
// columns (identified by its column prefix + value).
type Active =
  | { kind: 'code'; code: string }
  | { kind: 'attr'; col: string; val: string }
  | null;

// Map a spawn/leads label to a class colour where one exists, for the row text.
function labelColor(label: string): string | undefined {
  const m: Record<string, SystemClass> = {
    'Class 1': 'C1', 'Class 2': 'C2', 'Class 3': 'C3', 'Class 4': 'C4', 'Class 5': 'C5', 'Class 6': 'C6',
    'HighSec': 'HS', 'LowSec': 'LS', 'NullSec': 'NS', 'Class 12 - Thera': 'Thera', 'Class 13 - Shattered': 'C13',
    'Pochven ▲ Trig space': 'Pochven',
    C1: 'C1', C2: 'C2', C3: 'C3', C4: 'C4', C5: 'C5', C6: 'C6', HS: 'HS', LS: 'LS', NS: 'NS',
    Thera: 'Thera', C13: 'C13', Pochven: 'Pochven',
  };
  const key = m[label];
  return key ? CLASS_COLORS[key] : undefined;
}

const ACCENT = '#5b9bff';
function codeLineColor(entry: WhChartEntry): string {
  return labelColor(entry.leads_to[0] ?? '') ?? ACCENT;
}

// Does an entry occupy this attribute column's value?
function entryHasAttr(e: WhChartEntry, col: string, val: string): boolean {
  switch (col) {
    case 'respawn': return e.respawn.includes(val as Respawn);
    case 'spawn':   return e.spawn_in.includes(val);
    case 'leads':   return e.leads_to.includes(val);
    case 'ship':    return e.ship_size === val;
    case 'mass':    return e.total_mass === val;
    case 'life':    return e.life_time === val;
    default:        return false;
  }
}

// The attribute keys an entry connects to.
function attrKeysFor(e: WhChartEntry): string[] {
  return [
    ...e.respawn.map((r) => `respawn:${r}`),
    ...e.spawn_in.map((v) => `spawn:${v}`),
    ...e.leads_to.map((v) => `leads:${v}`),
    ...(e.ship_size  ? [`ship:${e.ship_size}`]  : []),
    ...(e.total_mass ? [`mass:${e.total_mass}`] : []),
    ...(e.life_time  ? [`life:${e.life_time}`]  : []),
  ];
}

export function WhTypeChartModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const whTypes = useWormholeTypes();
  // Override each entry's hardcoded ship_size with the SDE-derived size.
  const chart = useMemo(
    () => WH_CHART.map((e) => ({ ...e, ship_size: shipSizeFromSde(e.wormhole, whTypes) ?? e.ship_size })),
    [whTypes],
  );
  const [active, setActive] = useState<Active>(null);
  // Pinned (clicked) selections persist on mouse-out so you can read the
  // highlighted result; hovering only previews while nothing is pinned.
  const [pinned, setPinned] = useState(false);
  const [search, setSearch] = useState('');

  const hover = (a: Active) => { if (!pinned) setActive(a); };
  const toggle = (a: Active, isSame: boolean) => {
    if (isSame && pinned) { setActive(null); setPinned(false); }
    else { setActive(a); setPinned(true); }
  };

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const codeListRef = useRef<HTMLDivElement | null>(null);
  const rows = useRef<Map<string, HTMLElement>>(new Map());
  const setRow = (key: string) => (el: HTMLElement | null) => {
    if (el) rows.current.set(key, el); else rows.current.delete(key);
  };

  const codes = useMemo(() => {
    const q = search.trim().toUpperCase();
    return chart.filter((w) => !q || w.wormhole.toUpperCase().includes(q));
  }, [search, chart]);

  // From the active selection, compute the connection pairs (each = a code row
  // to an attribute-value row), the highlight set, and the line colour. Works
  // both directions: a code → its values, or a value → every code that has it.
  const { pairs, highlight, lineColor } = useMemo(() => {
    const pairs: Array<{ code: string; attrKey: string }> = [];
    const hl = new Set<string>();
    let color = ACCENT;
    if (active?.kind === 'code') {
      const e = chart.find((w) => w.wormhole === active.code);
      if (e) {
        color = codeLineColor(e);
        hl.add(`code:${e.wormhole}`);
        for (const k of attrKeysFor(e)) { hl.add(k); pairs.push({ code: e.wormhole, attrKey: k }); }
      }
    } else if (active?.kind === 'attr') {
      const attrKey = `${active.col}:${active.val}`;
      hl.add(attrKey);
      color = labelColor(active.val) ?? ACCENT;
      for (const e of chart) {
        if (entryHasAttr(e, active.col, active.val)) {
          hl.add(`code:${e.wormhole}`);
          pairs.push({ code: e.wormhole, attrKey });
        }
      }
    }
    return { pairs, highlight: hl, lineColor: color };
  }, [active, chart]);

  const [lines, setLines] = useState<Line[]>([]);

  useLayoutEffect(() => {
    function recompute() {
      const body = bodyRef.current;
      if (!body || pairs.length === 0) { setLines([]); return; }
      const base = body.getBoundingClientRect();
      const list = codeListRef.current?.getBoundingClientRect();
      const out: Line[] = [];
      for (const p of pairs) {
        const codeEl = rows.current.get(`code:${p.code}`);
        const attrEl = rows.current.get(p.attrKey);
        if (!codeEl || !attrEl) continue;        // code may be filtered out by search
        const cr = codeEl.getBoundingClientRect();
        const ar = attrEl.getBoundingClientRect();
        const sx = cr.right - base.left;
        let sy = cr.top - base.top + cr.height / 2;
        // Clamp the code endpoint to the visible scroll band so off-screen
        // codes don't trail lines into space.
        if (list) sy = Math.max(list.top - base.top, Math.min(list.bottom - base.top, sy));
        const tx = ar.left - base.left;
        const ty = ar.top - base.top + ar.height / 2;
        const dx = Math.max(40, (tx - sx) * 0.45);
        out.push({ d: `M ${sx},${sy} C ${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`, color: lineColor });
      }
      setLines(out);
    }
    recompute();
    const list = codeListRef.current;
    list?.addEventListener('scroll', recompute);
    window.addEventListener('resize', recompute);
    return () => { list?.removeEventListener('scroll', recompute); window.removeEventListener('resize', recompute); };
  }, [pairs, lineColor]);

  const sameAttr = (col: string, v: string) =>
    active?.kind === 'attr' && active.col === col && active.val === v;

  const col = (
    title: string,
    keyPrefix: string,
    values: readonly string[],
    opts?: { colorize?: boolean; className?: string },
  ) => (
    <div className={`whchart__col ${opts?.className ?? ''}`}>
      <div className="whchart__col-head">{title}</div>
      {values.map((v) => {
        const key = `${keyPrefix}:${v}`;
        const on = highlight.has(key);
        const c = opts?.colorize ? labelColor(v) : undefined;
        return (
          <div
            key={key}
            ref={setRow(key)}
            className={`whchart__cell whchart__cell--hit${on ? ' whchart__cell--on' : ''}`}
            // Dim non-highlighted colour via text alpha (#rrggbb + 8c ≈ 0.55),
            // NOT element opacity — opacity would make the cell box translucent
            // too and let connector lines show through it.
            style={on && c ? { color: c } : c && !on ? { color: `${c}8c` } : undefined}
            onMouseEnter={() => hover({ kind: 'attr', col: keyPrefix, val: v })}
            onClick={() => toggle({ kind: 'attr', col: keyPrefix, val: v }, sameAttr(keyPrefix, v))}
          >
            {v}
          </div>
        );
      })}
    </div>
  );

  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal whchart" role="dialog" aria-modal="true">
        <div className="modal__header">
          <h2 className="modal__title">{t('whChart.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={16} weight="bold" />
          </button>
        </div>

        <div className="modal__body whchart__body" ref={bodyRef} onMouseLeave={() => { if (!pinned) setActive(null); }}>
          <svg className="whchart__lines" aria-hidden="true">
            {lines.map((l, i) => (
              <path key={i} d={l.d} fill="none" strokeWidth={1.5} opacity={0.85} style={{ stroke: l.color }} />
            ))}
          </svg>

          {/* Codes */}
          <div className="whchart__col whchart__col--codes">
            <div className="whchart__col-head">
              {t('whChart.colWormholes')}
              <input
                className="whchart__search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('whChart.searchPlaceholder')}
                spellCheck={false}
              />
            </div>
            <div className="whchart__codes" ref={codeListRef}>
              {codes.map((w) => {
                const on = highlight.has(`code:${w.wormhole}`);
                return (
                  <div
                    key={w.wormhole}
                    ref={setRow(`code:${w.wormhole}`)}
                    className={`whchart__code${on ? ' whchart__code--active' : ''}`}
                    onMouseEnter={() => hover({ kind: 'code', code: w.wormhole })}
                    onClick={() => toggle({ kind: 'code', code: w.wormhole }, active?.kind === 'code' && active.code === w.wormhole)}
                  >
                    {w.wormhole}
                  </div>
                );
              })}
            </div>
          </div>

          {col(t('whChart.colRespawn'),  'respawn', RESPAWN_ORDER, { className: 'whchart__col--narrow' })}
          {col(t('whChart.colSpawnIn'),  'spawn',   SPAWN_ORDER,   { colorize: true })}
          {col(t('whChart.colLeadsTo'),  'leads',   LEADS_ORDER,   { colorize: true })}
          {col(t('whChart.colShipSize'), 'ship',    SHIP_ORDER)}
          {col(t('whChart.colTotalMass'),'mass',    MASS_ORDER)}
          {col(t('whChart.colLifetime'), 'life',    LIFE_ORDER, { className: 'whchart__col--narrow' })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
