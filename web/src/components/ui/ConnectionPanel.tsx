import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { mass } from '../../i18n/format';
import { useMapStore } from '../../store/mapStore';
import { useWormholeTypes } from '../../hooks/useWormholeTypes';
import { useNow30s } from '../../hooks/useNow30s';
import { useCanEdit } from '../../hooks/useCanEdit';
import { systemDisplayName } from '../../utils/systemName';
import { useCharacterLocation } from '../../hooks/useCharacterLocation';
import { WHTypeInfo } from './WHTypeInfo';
import { Select } from './Select';
import { whSizeForType } from '../../utils/wormholeSize';
import { effectiveExpiryMs, lifeBucket, knownMaxLifeHours } from '../../utils/whLifetime';
import { ConfirmModal } from './ConfirmModal';
import { IconPickerDialog } from './IconPickerDialog';
import { XIcon, TagIcon } from '@phosphor-icons/react';
import { iconComponent } from '../../utils/phosphorIcons';
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

// Inverse of deriveStatus: the most-remaining edge of each status band. Used
// when the pilot picks a mass status by hand (they eyeballed the hole in-game,
// or someone else rolled it) so the rolling calculator reflects that state
// instead of only counting passes it saw. Each maps to the boundary — the
// optimistic edge — of its band: destabilized = 50% left, critical = 10% left.
const STATUS_REMAINING_FRACTION: Record<MassStatus, number> = {
  stable:       1.0,
  destabilized: 0.50,
  critical:     0.10,
};
function massUsedForStatus(status: MassStatus, totalMass: number): number {
  return Math.round(totalMass * (1 - STATUS_REMAINING_FRACTION[status]));
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
  // Open state for the connection-flag icon picker.
  const [flagPickerOpen, setFlagPickerOpen] = useState(false);
  // Signatures on the two endpoint systems — feeds both the WH-type auto-detect
  // and the per-end "backing signature" link dropdowns below.
  const [endpointSigs, setEndpointSigs] = useState<{ src: Signature[]; tgt: Signature[] }>({ src: [], tgt: [] });

  // No-op the mutation calls when the user lacks topology permission. The
  // panel still renders so readonly users can inspect the connection.
  const updateConnection: typeof rawUpdate = (...args) => { if (canEdit) rawUpdate(...args); };
  const removeConnection: typeof rawRemove = (...args) => { if (canEdit) rawRemove(...args); };

  const conn = map.connections.find((c) => c.id === selectedConnectionId);
  const src = conn ? map.systems.find((s) => s.id === conn.sourceId) : undefined;
  const tgt = conn ? map.systems.find((s) => s.id === conn.targetId) : undefined;

  // Fetch the signatures on both endpoint systems whenever the selected
  // connection (or its endpoints) changes. Held in state so both the WH-type
  // auto-detect and the link dropdowns read the same list. Cleared for
  // gate / Ansiblex links, which are never wormholes.
  useEffect(() => {
    if (!conn || !src || !tgt || !map.id || conn.connectionType !== 'standard') {
      setEndpointSigs({ src: [], tgt: [] });
      return;
    }
    let cancelled = false;
    Promise.all([
      api<Signature[]>(`/api/maps/${map.id}/systems/${src.id}/signatures`).catch(() => [] as Signature[]),
      api<Signature[]>(`/api/maps/${map.id}/systems/${tgt.id}/signatures`).catch(() => [] as Signature[]),
    ]).then(([s, tg]) => { if (!cancelled) setEndpointSigs({ src: s, tgt: tg }); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id, src?.id, tgt?.id, map.id, conn?.connectionType]);

  // Auto-detect the WH type from the fetched endpoint signatures. Only fills if
  // conn.type is strictly `null` (never touched) so manual entries — including
  // manual clearing to '' — are never overwritten. Already-set K162 may be
  // upgraded to the real code from the other side.
  useEffect(() => {
    if (!conn || !src || !tgt || conn.connectionType !== 'standard') return;
    if (conn.type !== null && conn.type.toUpperCase() !== 'K162') return;
    const detected = detectWhType(endpointSigs.src, endpointSigs.tgt, src, tgt);
    if (!detected) return;
    if (conn.type && conn.type.toUpperCase() === 'K162' && detected === 'K162') return;
    updateConnection(conn.id, { type: detected });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id, endpointSigs]);

  // Default the connection's size from its wormhole type's SDE max-jump-mass,
  // once per (connection, type). Leaves manual size changes intact (the key
  // only changes when the *type* changes), and never overrides a code we can't
  // size yet (waits for the types to load). Wormhole connections only.
  const sizeSyncedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!conn || conn.connectionType !== 'standard') return;
    const code = conn.type?.toUpperCase();
    if (!code) return;
    const key = `${conn.id}:${code}`;
    if (key === sizeSyncedFor.current) return;
    const cls = whSizeForType(code, whTypes);
    if (!cls) return; // types not loaded yet / unknown code — retry on load
    sizeSyncedFor.current = key;
    if (cls !== conn.size) updateConnection(conn.id, { size: cls });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id, conn?.type, conn?.connectionType, whTypes]);

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

  // Candidate sigs for the per-end "backing signature" link: wormholes, plus
  // unclassified sigs (an unscanned hole). Labelled by sig code + WH type.
  const linkSigs = (list: Signature[]) =>
    list.filter((s) => s.sigType === 'wormhole' || s.sigType === 'unknown');
  const sigLabel = (s: Signature) => {
    const code = s.sigId || t('connPanel.sigUnnamed');
    return s.whType ? `${code} · ${s.whType}` : code;
  };

  const whSpec = conn.type ? whTypes[conn.type.toUpperCase()] : undefined;
  const massUsed = conn.massUsed ?? 0;

  const addMass = (kg: number) => {
    if (!whSpec) return;
    const next = Math.max(0, massUsed + kg);
    // Derive the status from the WORST-case remaining — the same basis as the
    // calculator's fill bar and pass warnings — so a pass that pushes the hole
    // into the critical band flags Critical, not just Destabilized. Deriving
    // from nominal here lagged: the bar went red while the dropdown stayed
    // destabilized.
    const r = massRange(whSpec.totalMass, next);
    const nextStatus = deriveStatus(r.worstRemaining / (r.worstTotal || 1));
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

  // Picking a mass status by hand also seeds massUsed to that band's boundary,
  // so the rolling calculator's remaining estimate reflects the chosen state
  // (setting Critical drops "left" to ~10%, not the full bar). The previous
  // per-pass undo history no longer matches, so clear it (keep the roll side).
  const changeMassStatus = (status: MassStatus) => {
    if (whSpec) update({ massStatus: status, massUsed: massUsedForStatus(status, whSpec.totalMass) });
    else        update({ massStatus: status });
    if (conn && stack.length) {
      setStack([]);
      saveSession(conn.id, { side, stack: [] });
    }
  };

  // Wormhole-only fields (type, sig link, mass / time / size, rolling calc)
  // don't apply to stargates or Ansiblex jump bridges — only 'standard' links.
  const isWormhole = conn.connectionType === 'standard';

  return (
    <aside className="system-panel">
      <div className="system-panel__header">
        <h2 className="system-panel__title">
          {src ? systemDisplayName(src) : '?'} → {tgt ? systemDisplayName(tgt) : '?'}
        </h2>
        <button className="icon-btn" onClick={() => selectConnection(null)} title={t('actions.close')}><XIcon size={14} weight="bold" /></button>
      </div>

      {conn.broken && (
        <div className="conn-broken-banner">
          <span className="conn-broken-banner__text">{t('connPanel.brokenNotice')}</span>
          <button
            type="button"
            className="sys-btn"
            disabled={!canEdit}
            onClick={() => update({ broken: false })}
            title={t('connPanel.restoreTitle')}
          >
            {t('connPanel.restore')}
          </button>
        </div>
      )}

      {!isWormhole && (
        <p className="conn-gate-note">
          {t(conn.connectionType === 'jumpgate' ? 'connPanel.jumpgateNote' : 'connPanel.gateNote')}
        </p>
      )}

      {isWormhole && (<>
      {/* Column 1 — wormhole type + backing signatures */}
      <div className="conn-col conn-col--wh">
      <label className="field">
        <span>{t('connPanel.whType')} <WHTypeInfo code={conn.type} /></span>
        <input
          type="text"
          value={conn.type ?? ''}
          onChange={(e) => update({ type: e.target.value.toUpperCase() })}
          placeholder={t('connPanel.whTypePlaceholder')}
        />
      </label>

      {conn.connectionType === 'standard' && (
        <div className="conn-siglink">
          <div className="conn-siglink__label">{t('connPanel.sigLink')}</div>
          <label className="field">
            <span>{t('connPanel.sigInSystem', { system: src ? systemDisplayName(src) : '?' })}</span>
            <Select
              value={conn.sourceSignatureId ?? ''}
              disabled={!canEdit}
              onChange={(v) => update({ sourceSignatureId: v || null })}
              options={[
                { value: '', label: t('connPanel.sigNone') },
                ...linkSigs(endpointSigs.src).map((s) => ({ value: s.id, label: sigLabel(s) })),
              ]}
            />
          </label>
          <label className="field">
            <span>{t('connPanel.sigInSystem', { system: tgt ? systemDisplayName(tgt) : '?' })}</span>
            <Select
              value={conn.targetSignatureId ?? ''}
              disabled={!canEdit}
              onChange={(v) => update({ targetSignatureId: v || null })}
              options={[
                { value: '', label: t('connPanel.sigNone') },
                ...linkSigs(endpointSigs.tgt).map((s) => ({ value: s.id, label: sigLabel(s) })),
              ]}
            />
          </label>
        </div>
      )}
      </div>

      {/* Column 2 — mass / time / size */}
      <div className="conn-col conn-col--status">
      <label className="field">
        <span>{t('connPanel.massStatus')}</span>
        <Select
          value={conn.massStatus ?? ''}
          onChange={(v) => changeMassStatus(v as MassStatus)}
          options={[
            { value: 'stable', label: t('connPanel.stable') },
            { value: 'destabilized', label: t('connPanel.destabilized') },
            { value: 'critical', label: t('connPanel.critical') },
          ]}
        />
      </label>

      <label className="field">
        <span>{t('connPanel.timeStatus')}</span>
        <Select
          value={(() => {
            // Derive the live stage from the hole's effective expiry so the
            // dropdown tracks the same countdown the edge label shows.
            const expiry = effectiveExpiryMs(conn, whTypes);
            if (expiry != null) return lifeBucket(expiry - now);
            return conn.timeStatus === 'lessThan24h' ? 'lessThan24h' : 'fresh';
          })()}
          onChange={(val) => {
            const v = val as TimeStatus;
            // A picked stage becomes a manual expiry that then ages from now.
            const expiresIn = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
            const maxLife = knownMaxLifeHours(conn, whTypes);
            switch (v) {
              case 'fresh':       update({ timeStatus: 'fresh',       eolAt: null, lifetimeExpiresAt: maxLife ? expiresIn(maxLife) : null }); break;
              case 'lessThan24h': update({ timeStatus: 'lessThan24h', eolAt: null, lifetimeExpiresAt: expiresIn(24) }); break;
              case 'lessThan4h':  update({ timeStatus: 'lessThan4h',  eolAt: null, lifetimeExpiresAt: expiresIn(4) });  break;
              case 'lessThan1h':  update({ timeStatus: 'lessThan1h',  eolAt: null, lifetimeExpiresAt: expiresIn(1) });  break;
              case 'expired':     update({ timeStatus: 'expired',     eolAt: null, lifetimeExpiresAt: expiresIn(0) });  break;
            }
          }}
          options={[
            ...((knownMaxLifeHours(conn, whTypes) ?? 48) > 24
              ? [{ value: 'fresh', label: t('connPanel.fresh') }]
              : []),
            { value: 'lessThan24h', label: t('connPanel.lessThan1d') },
            { value: 'lessThan4h', label: t('connPanel.lessThan4h') },
            { value: 'lessThan1h', label: t('connPanel.lessThan1h') },
            { value: 'expired', label: t('connPanel.expired') },
          ]}
        />
      </label>

      <label className="field">
        <span>{t('connPanel.size')}</span>
        <Select
          value={conn.size}
          onChange={(v) => update({ size: v as ConnectionSize })}
          options={[
            { value: 'xl', label: t('connPanel.sizeXl') },
            { value: 'large', label: t('connPanel.sizeLarge') },
            { value: 'medium', label: t('connPanel.sizeMedium') },
            { value: 'small', label: t('connPanel.sizeSmall') },
          ]}
        />
      </label>
      </div>

      {/* Column 3 — flag */}
      <div className="conn-col conn-col--flag">
      {/* Corp/alliance-shared flag: a single icon + note surfaced on the edge
          (e.g. "DO NOT ROLL — fleet inbound"). Setting a new icon replaces the
          old one. Synced to every viewer via the connection update path. */}
      <label className="field conn-flag">
        <span>{t('connPanel.flagLabel')}</span>
        <div className="conn-flag__row">
          {(() => {
            const FlagIcon = conn.flagIcon ? iconComponent(conn.flagIcon) : null;
            return (
              <button
                type="button"
                className="sys-btn conn-flag__pick"
                disabled={!canEdit}
                onClick={() => setFlagPickerOpen(true)}
                title={t('connPanel.flagAdd')}
              >
                {FlagIcon ? <FlagIcon size={16} weight="fill" /> : <TagIcon size={16} />}
                {!FlagIcon && <span>{t('connPanel.flagAdd')}</span>}
              </button>
            );
          })()}
          {conn.flagIcon && (
            <input
              type="color"
              className="conn-flag__color"
              value={conn.flagColor ?? '#f0a030'}
              disabled={!canEdit}
              onChange={(e) => update({ flagColor: e.target.value })}
              title={t('connPanel.flagColor')}
              aria-label={t('connPanel.flagColor')}
            />
          )}
          {conn.flagIcon && (
            <button
              type="button"
              className="icon-btn conn-flag__remove"
              disabled={!canEdit}
              onClick={() => update({ flagIcon: null, flagNote: null, flagColor: null, flagBlink: false })}
              data-tooltip={t('connPanel.flagRemove')}
            >
              <XIcon size={14} weight="bold" />
            </button>
          )}
        </div>
        {conn.flagIcon && (
          <input
            type="text"
            value={conn.flagNote ?? ''}
            maxLength={200}
            disabled={!canEdit}
            onChange={(e) => update({ flagNote: e.target.value || null })}
            placeholder={t('connPanel.flagNotePlaceholder')}
          />
        )}
        {conn.flagIcon && (
          <label className="conn-flag__blink">
            <input
              type="checkbox"
              checked={conn.flagBlink}
              disabled={!canEdit}
              onChange={(e) => update({ flagBlink: e.target.checked })}
            />
            <span>{t('connPanel.flagBlink')}</span>
          </label>
        )}
      </label>
      </div>

      {flagPickerOpen && (
        <IconPickerDialog
          current={conn.flagIcon}
          onPick={(name) => update({ flagIcon: name })}
          onClose={() => setFlagPickerOpen(false)}
        />
      )}

      {/* Column 4 — rolling calculator */}
      <div className="conn-col conn-col--roller">
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
              <Select
                value={presetName}
                onChange={(v) => {
                  const p = ROLLER_PRESETS.find(x => x.name === v);
                  if (p) setRoller({ ...p });
                }}
                options={[
                  ...ROLLER_PRESETS.map(p => ({ value: p.name, label: p.name })),
                  { value: 'Custom', label: t('connPanel.custom') },
                ]}
              />
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
      </div>

      {pendingPass && (
        <ConfirmModal
          message={t('connPanel.collapseConfirm', { mass: fmtMass(pendingPass.kg) }) + (pendingPass.strand ? t('connPanel.collapseConfirmStrand') : t('connPanel.collapseConfirmHome'))}
          confirmLabel={t('connPanel.rollIt')}
          showDontAskAgain={false}
          onConfirm={() => { applyPass(pendingPass.kg); setPendingPass(null); }}
          onCancel={() => setPendingPass(null)}
        />
      )}
      </>)}

      <button
        className="btn btn--danger"
        onClick={() => { removeConnection(conn.id); }}
      >
        {t('connPanel.removeConnection')}
      </button>
    </aside>
  );
}
