import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { mass } from '../../i18n/format';
import { useMapStore } from '../../store/mapStore';
import { useWormholeTypes } from '../../hooks/useWormholeTypes';
import { useNow30s } from '../../hooks/useNow30s';
import { useCanEdit } from '../../hooks/useCanEdit';
import { useCharacterLocation } from '../../hooks/useCharacterLocation';
import { WHTypeInfo } from './WHTypeInfo';
import { ConfirmModal } from './ConfirmModal';
import { XIcon } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { MassStatus, TimeStatus, ConnectionSize, Signature, SystemClass } from '../../types';
import {
  massRange, collapseState, passOutcome, safePassesLeft, flipSide,
  loadRoller, saveRoller, loadSession, saveSession,
  ROLLER_PRESETS, PROP_MASS,
  type RollerShip, type RollSide,
} from '../../utils/rolling';

// Common rolling-mass presets, in kg
const PRESETS: Array<{ label: string; kg: number }> = [
  { label: '+ Frigate (1.5)',  kg:   1_500_000 },
  { label: '+ Cruiser (12)',   kg:  12_000_000 },
  { label: '+ HIC (15)',       kg:  15_000_000 },
  { label: '+ BS cold (100)',  kg: 100_000_000 },
  { label: '+ BS hot (200)',   kg: 200_000_000 },
  { label: '+ Dread (1300)',   kg: 1_300_000_000 },
];

// Compact mass for button labels: "200M", "1.3B".
function massShort(kg: number): string {
  if (kg >= 1_000_000_000) return `${(kg / 1_000_000_000).toFixed(1)}B`;
  return `${Math.round(kg / 1_000_000)}M`;
}

function deriveStatus(remainingFraction: number): MassStatus {
  if (remainingFraction <= 0.10) return 'critical';
  if (remainingFraction <= 0.50) return 'destabilized';
  return 'stable';
}

// Match a sig's `whLeadsTo` against the other endpoint. The dropdown can
// store either a class abbrev ("C2") or a system name ("J123456"), so we
// accept either.
function sigPointsAtOther(
  sig:  Signature,
  otherClass: string,
  otherName:  string,
): boolean {
  if (!sig.whType || !sig.whLeadsTo) return false;
  const target = sig.whLeadsTo.toUpperCase();
  return target === otherClass.toUpperCase() ||
         target === otherName.toUpperCase();
}

// Given the signatures on both endpoint systems, find a WH code from a sig
// whose leads-to matches the other endpoint. Prefer a non-K162 code since
// K162 carries no mass spec — the other side has the real WH type.
function detectWhType(
  srcSigs: Signature[],
  tgtSigs: Signature[],
  src:     { systemClass: SystemClass; name: string },
  tgt:     { systemClass: SystemClass; name: string },
): string | null {
  const matches: string[] = [];
  for (const s of srcSigs) {
    if (sigPointsAtOther(s, tgt.systemClass, tgt.name)) matches.push(s.whType.toUpperCase());
  }
  for (const s of tgtSigs) {
    if (sigPointsAtOther(s, src.systemClass, src.name)) matches.push(s.whType.toUpperCase());
  }
  if (matches.length === 0) return null;
  return matches.find(t => t !== 'K162') ?? matches[0];
}

export function ConnectionPanel() {
  const { t } = useTranslation();
  const fmtMass = (kg: number) => mass(t, kg);
  const collapseLabel: Record<string, string> = {
    open:      t('connPanel.collapse.open'),
    maybe:     t('connPanel.collapse.maybe'),
    collapsed: t('connPanel.collapse.collapsed'),
  };
  const { map, selectedConnectionId, updateConnection: rawUpdate, removeConnection: rawRemove, selectConnection } =
    useMapStore();
  const whTypes = useWormholeTypes();
  const now     = useNow30s();
  const canEdit = useCanEdit();
  const location = useCharacterLocation();

  // Rolling state. The roller ship (cold/hot mass) is a per-pilot preference;
  // the per-connection session (which side the roller is on + the stack of
  // applied passes, for undo) is local to this pilot too — only the cumulative
  // `massUsed` is shared/synced. See rolling_calc_feature.md.
  const [roller, setRoller] = useState<RollerShip>(() => loadRoller());
  const [side,   setSide]   = useState<RollSide>('home');
  const [stack,  setStack]  = useState<number[]>([]);
  const [pendingPass, setPendingPass] = useState<{ kg: number; strand: boolean } | null>(null);
  const [sessionConnId, setSessionConnId] = useState<string | undefined>(undefined);

  // No-op the mutation calls when the user lacks topology permission. The
  // panel still renders so readonly users can inspect the connection.
  const updateConnection: typeof rawUpdate = (...args) => { if (canEdit) rawUpdate(...args); };
  const removeConnection: typeof rawRemove = (...args) => { if (canEdit) rawRemove(...args); };

  const conn = map.connections.find((c) => c.id === selectedConnectionId);
  const src = conn ? map.systems.find((s) => s.id === conn.sourceId) : undefined;
  const tgt = conn ? map.systems.find((s) => s.id === conn.targetId) : undefined;

  // Auto-detect the WH type from signatures on the two endpoint systems.
  // Fires once when a new connection is selected. Only fills if conn.type is
  // strictly `null` (never touched) so manual entries — including manual
  // clearing to '' — are never overwritten. Already-set K162 may be upgraded.
  useEffect(() => {
    if (!conn || !src || !tgt || !map.id) return;
    if (conn.type !== null && conn.type.toUpperCase() !== 'K162') return;
    let cancelled = false;
    Promise.all([
      api<Signature[]>(`/api/maps/${map.id}/systems/${src.id}/signatures`).catch(() => [] as Signature[]),
      api<Signature[]>(`/api/maps/${map.id}/systems/${tgt.id}/signatures`).catch(() => [] as Signature[]),
    ]).then(([srcSigs, tgtSigs]) => {
      if (cancelled || !conn) return;
      const detected = detectWhType(srcSigs, tgtSigs, src, tgt);
      if (!detected) return;
      // Don't downgrade an existing K162 to itself, only to a real code.
      if (conn.type && conn.type.toUpperCase() === 'K162' && detected === 'K162') return;
      updateConnection(conn.id, { type: detected });
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id]);

  // Persist the roller config whenever the pilot tweaks it.
  useEffect(() => { saveRoller(roller); }, [roller]);

  // Load the roll session (side + undo stack) when the selected connection
  // changes. Done during render (React's "adjust state on prop change" pattern)
  // rather than in an effect, so there's no extra commit. The pass handlers
  // persist explicitly, so this only ever reads.
  if (conn?.id !== sessionConnId) {
    const s = loadSession(conn?.id);
    setSessionConnId(conn?.id);
    setSide(s.side);
    setStack(s.stack);
    setPendingPass(null);
  }

  if (!conn) return null;

  const update = (updates: Parameters<typeof updateConnection>[1]) =>
    updateConnection(conn.id, updates);

  const whSpec = conn.type ? whTypes[conn.type.toUpperCase()] : undefined;
  const massUsed = conn.massUsed ?? 0;

  const addMass = (kg: number) => {
    if (!whSpec) return;
    const next = Math.max(0, massUsed + kg);
    const nextStatus = deriveStatus((whSpec.totalMass - next) / whSpec.totalMass);
    update({ massUsed: next, massStatus: nextStatus });
  };

  // A roller pass: add its mass, flip the side, push onto the undo stack.
  const applyPass = (kg: number) => {
    if (!conn) return;
    const newStack = [...stack, kg];
    const newSide  = flipSide(side);
    setStack(newStack);
    setSide(newSide);
    saveSession(conn.id, { side: newSide, stack: newStack });
    addMass(kg);
  };

  // Click handler for a pass button — confirm first if it would collapse the hole.
  const onPass = (kg: number) => {
    if (!whSpec) return;
    if (passOutcome(whSpec.totalMass, massUsed, kg) === 'collapse') {
      setPendingPass({ kg, strand: flipSide(side) === 'far' });
      return;
    }
    applyPass(kg);
  };

  const undoPass = () => {
    if (!conn || stack.length === 0) return;
    const last     = stack[stack.length - 1];
    const newStack = stack.slice(0, -1);
    const newSide  = flipSide(side);
    setStack(newStack);
    setSide(newSide);
    saveSession(conn.id, { side: newSide, stack: newStack });
    addMass(-last);
  };

  const resetRoll = () => {
    if (!conn) return;
    setStack([]);
    setSide('home');
    saveSession(conn.id, { side: 'home', stack: [] });
    update({ massUsed: 0, massStatus: 'stable' });
  };

  return (
    <aside className="system-panel">
      <div className="system-panel__header">
        <h2 className="system-panel__title">
          {src?.name ?? '?'} → {tgt?.name ?? '?'}
        </h2>
        <button className="icon-btn" onClick={() => selectConnection(null)} title={t('actions.close')}><XIcon size={14} weight="bold" /></button>
      </div>

      <label className="field">
        <span>{t('connPanel.whType')} <WHTypeInfo code={conn.type} /></span>
        <input
          type="text"
          value={conn.type ?? ''}
          onChange={(e) => update({ type: e.target.value.toUpperCase() })}
          placeholder={t('connPanel.whTypePlaceholder')}
        />
      </label>

      <label className="field">
        <span>{t('connPanel.massStatus')}</span>
        <select
          value={conn.massStatus ?? ''}
          onChange={(e) => update({ massStatus: e.target.value as MassStatus })}
        >
          <option value="stable">{t('connPanel.stable')}</option>
          <option value="destabilized">{t('connPanel.destabilized')}</option>
          <option value="critical">{t('connPanel.critical')}</option>
        </select>
      </label>

      <label className="field">
        <span>{t('connPanel.timeStatus')}</span>
        <select
          value={(() => {
            // Derive the live stage from eolAt + timeStatus so the dropdown
            // tracks the same countdown the edge label shows.
            if (conn.timeStatus === 'lessThan24h' && !conn.eolAt) return 'lessThan24h';
            if (conn.eolAt) {
              const elapsedH = (now - new Date(conn.eolAt).getTime()) / 3_600_000;
              if (elapsedH >= 4) return 'expired';
              if (elapsedH >= 3) return 'lessThan1h';
              return 'lessThan4h';
            }
            return 'fresh';
          })()}
          onChange={(e) => {
            const v = e.target.value as TimeStatus;
            const offset = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
            switch (v) {
              case 'fresh':       update({ timeStatus: 'fresh',       eolAt: null });            break;
              case 'lessThan24h': update({ timeStatus: 'lessThan24h', eolAt: null });            break;
              case 'lessThan4h':  update({ timeStatus: 'eol',         eolAt: offset(0) });        break;
              case 'lessThan1h':  update({ timeStatus: 'eol',         eolAt: offset(3) });        break;
              case 'expired':     update({ timeStatus: 'eol',         eolAt: offset(4) });        break;
            }
          }}
        >
          <option value="fresh">{t('connPanel.fresh')}</option>
          <option value="lessThan24h">{t('connPanel.lessThan1d')}</option>
          <option value="lessThan4h">{t('connPanel.lessThan4h')}</option>
          <option value="lessThan1h">{t('connPanel.lessThan1h')}</option>
          <option value="expired">{t('connPanel.expired')}</option>
        </select>
      </label>

      <label className="field">
        <span>{t('connPanel.size')}</span>
        <select
          value={conn.size}
          onChange={(e) => update({ size: e.target.value as ConnectionSize })}
        >
          <option value="xl">{t('connPanel.sizeXl')}</option>
          <option value="large">{t('connPanel.sizeLarge')}</option>
          <option value="medium">{t('connPanel.sizeMedium')}</option>
          <option value="small">{t('connPanel.sizeSmall')}</option>
        </select>
      </label>

      {whSpec ? (() => {
        const range    = massRange(whSpec.totalMass, massUsed);
        const cState   = collapseState(whSpec.totalMass, massUsed);
        const scaleMax = range.bestTotal || 1;
        const fillPct  = Math.min(100, (massUsed / scaleMax) * 100);
        const worstPct = (range.worstTotal / scaleMax) * 100;
        const fillStatus = deriveStatus(range.worstRemaining / (range.worstTotal || 1));

        const tooHeavyCold = roller.coldKg > whSpec.maxJumpMass;
        const tooHeavyHot  = roller.hotKg  > whSpec.maxJumpMass;
        const hotOutcome   = passOutcome(whSpec.totalMass, massUsed, roller.hotKg);
        const coldOutcome  = passOutcome(whSpec.totalMass, massUsed, roller.coldKg);

        const lightKg      = Math.min(roller.coldKg, roller.hotKg);
        const lightOutcome = passOutcome(whSpec.totalMass, massUsed, lightKg);
        const nextEndsFar  = flipSide(side) === 'far';
        const passes       = safePassesLeft(whSpec.totalMass, massUsed, roller.hotKg);

        let guidanceLevel: 'ok' | 'warn' | 'danger' = 'ok';
        let guidanceText: string;
        if (cState === 'collapsed') {
          guidanceLevel = 'danger';
          guidanceText  = t('connPanel.guidanceCollapsed');
        } else if (lightOutcome === 'safe') {
          guidanceText  = t('connPanel.guidanceSafe', { min: passes.min, max: passes.max, count: passes.max });
        } else if (lightOutcome === 'risky') {
          guidanceLevel = nextEndsFar ? 'danger' : 'warn';
          guidanceText  = nextEndsFar
            ? t('connPanel.guidanceRiskyFar')
            : t('connPanel.guidanceRiskyHome');
        } else {
          guidanceLevel = 'danger';
          guidanceText  = nextEndsFar
            ? t('connPanel.guidanceDangerFar')
            : t('connPanel.guidanceDangerHome');
        }

        const myShip = location.ship;
        const canUseMyShip = !!(myShip && myShip.mass != null && myShip.mass > 0);
        const presetName = ROLLER_PRESETS.find(p => p.coldKg === roller.coldKg && p.hotKg === roller.hotKg)?.name ?? 'Custom';
        const setMass = (key: 'coldKg' | 'hotKg', m: number) =>
          setRoller(r => ({ ...r, name: 'Custom', [key]: Math.max(0, Math.round(m * 1_000_000)) }));

        return (
        <div className="mass-tracker">
          <div className="mass-tracker__header">
            <span className="mass-tracker__label">{t('connPanel.rollingCalculator')}</span>
            <span className={`roll-pill roll-pill--${cState}`}>{collapseLabel[cState]}</span>
          </div>

          <div className="mass-tracker__bar">
            <div className="roll-band" style={{ left: `${worstPct}%`, width: `${100 - worstPct}%` }} title="±10% mass variance — collapse possible anywhere in here" />
            <div className={`mass-tracker__fill mass-tracker__fill--${fillStatus}`} style={{ width: `${fillPct}%` }} />
          </div>
          <div className="mass-tracker__remaining">
            {t('connPanel.remaining', {
              worst: fmtMass(range.worstRemaining),
              best: fmtMass(range.bestRemaining),
              used: fmtMass(massUsed),
              max: fmtMass(whSpec.maxJumpMass),
            })}
          </div>

          {/* Roller ship config (per-pilot, persisted) */}
          <div className="roller">
            <div className="roller__row">
              <select
                value={presetName}
                onChange={(e) => {
                  const p = ROLLER_PRESETS.find(x => x.name === e.target.value);
                  if (p) setRoller({ ...p });
                }}
              >
                {ROLLER_PRESETS.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                <option value="Custom">{t('connPanel.custom')}</option>
              </select>
              <button
                type="button"
                className="sys-btn"
                disabled={!canUseMyShip}
                title={canUseMyShip ? t('connPanel.useMyShipTitle', { ship: myShip!.typeName, mass: fmtMass(myShip!.mass!) }) : t('connPanel.noCurrentShip')}
                onClick={() => canUseMyShip && setRoller({ name: myShip!.typeName, coldKg: myShip!.mass!, hotKg: myShip!.mass! + PROP_MASS })}
              >
                {t('connPanel.useMyShip')}
              </button>
            </div>
            <div className="roller__masses">
              <label className="roller__mass">
                <span>{t('connPanel.cold')}</span>
                <input type="number" min={0} step={5} value={roller.coldKg / 1_000_000}
                  onChange={(e) => { const m = parseFloat(e.target.value); if (!isNaN(m)) setMass('coldKg', m); }} />
                <span className="roller__unit">M</span>
              </label>
              <label className="roller__mass">
                <span>{t('connPanel.hot')}</span>
                <input type="number" min={0} step={5} value={roller.hotKg / 1_000_000}
                  onChange={(e) => { const m = parseFloat(e.target.value); if (!isNaN(m)) setMass('hotKg', m); }} />
                <span className="roller__unit">M</span>
              </label>
            </div>
          </div>

          {tooHeavyCold ? (
            <div className="mass-tracker__budget mass-tracker__budget--blocked">
              {t('connPanel.tooHeavyCold', { mass: fmtMass(roller.coldKg), max: fmtMass(whSpec.maxJumpMass) })}
            </div>
          ) : (
            <>
              <div className="roll-side">
                {t('connPanel.roller')} <span className={`roll-side__dot roll-side__dot--${side}`} />
                <strong>{side === 'home' ? t('connPanel.homeSideLabel') : t('connPanel.farSideLabel')}</strong>
              </div>

              <div className="roll-pass">
                <button
                  type="button"
                  className={`sys-btn roll-pass__btn roll-pass__btn--${hotOutcome}`}
                  disabled={!canEdit || tooHeavyHot}
                  title={tooHeavyHot ? t('connPanel.tooHeavyHotTitle') : t('connPanel.passTitle', { mass: fmtMass(roller.hotKg), side: nextEndsFar ? t('connPanel.far') : t('connPanel.home') })}
                  onClick={() => onPass(roller.hotKg)}
                >
                  {t('connPanel.passHot', { mass: massShort(roller.hotKg) })}
                </button>
                <button
                  type="button"
                  className={`sys-btn roll-pass__btn roll-pass__btn--${coldOutcome}`}
                  disabled={!canEdit}
                  title={t('connPanel.passTitle', { mass: fmtMass(roller.coldKg), side: nextEndsFar ? t('connPanel.far') : t('connPanel.home') })}
                  onClick={() => onPass(roller.coldKg)}
                >
                  {t('connPanel.passCold', { mass: massShort(roller.coldKg) })}
                </button>
              </div>

              <div className={`roll-guidance roll-guidance--${guidanceLevel}`}>{guidanceText}</div>

              <div className="roll-actions">
                <button type="button" className="sys-btn" disabled={!canEdit || stack.length === 0} onClick={undoPass}>
                  {t('connPanel.undoPass')}
                </button>
                <button type="button" className="sys-btn mass-tracker__reset" disabled={!canEdit} onClick={resetRoll}>
                  {t('connPanel.reset')}
                </button>
              </div>
            </>
          )}

          {/* Other ships passed (not your roller — feed the same total, no side flip) */}
          <details className="roll-other">
            <summary>{t('connPanel.otherShips')}</summary>
            <div className="mass-tracker__buttons">
              {PRESETS
                .filter(p => p.kg <= whSpec.maxJumpMass || p.kg < 200_000_000)
                .map(p => (
                  <button key={p.label} type="button" className="sys-btn mass-tracker__btn"
                    disabled={!canEdit} onClick={() => addMass(p.kg)}>
                    {p.label}
                  </button>
                ))}
            </div>
          </details>
        </div>
        );
      })() : conn.type ? (
        <div className="mass-tracker__hint">{t('connPanel.noMassData', { type: conn.type })}</div>
      ) : (
        <div className="mass-tracker__hint">{t('connPanel.enterWhType')}</div>
      )}

      {pendingPass && (
        <ConfirmModal
          message={t('connPanel.collapseConfirm', { mass: fmtMass(pendingPass.kg) }) + (pendingPass.strand ? t('connPanel.collapseConfirmStrand') : t('connPanel.collapseConfirmHome'))}
          confirmLabel={t('connPanel.rollIt')}
          showDontAskAgain={false}
          onConfirm={() => { applyPass(pendingPass.kg); setPendingPass(null); }}
          onCancel={() => setPendingPass(null)}
        />
      )}

      <button
        className="btn btn--danger"
        onClick={() => { removeConnection(conn.id); }}
      >
        {t('connPanel.removeConnection')}
      </button>
    </aside>
  );
}
