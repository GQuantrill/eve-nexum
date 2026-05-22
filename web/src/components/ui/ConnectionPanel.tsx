import { useEffect } from 'react';
import { useMapStore } from '../../store/mapStore';
import { useWormholeTypes } from '../../hooks/useWormholeTypes';
import { useNow30s } from '../../hooks/useNow30s';
import { useCanEdit } from '../../hooks/useCanEdit';
import { useCharacterLocation } from '../../hooks/useCharacterLocation';
import { WHTypeInfo } from './WHTypeInfo';
import { XIcon } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { MassStatus, TimeStatus, ConnectionSize, Signature, SystemClass } from '../../types';

// Common rolling-mass presets, in kg
const PRESETS: Array<{ label: string; kg: number }> = [
  { label: '+ Frigate (1.5)',  kg:   1_500_000 },
  { label: '+ Cruiser (12)',   kg:  12_000_000 },
  { label: '+ HIC (15)',       kg:  15_000_000 },
  { label: '+ BS cold (100)',  kg: 100_000_000 },
  { label: '+ BS hot (200)',   kg: 200_000_000 },
  { label: '+ Dread (1300)',   kg: 1_300_000_000 },
];

function formatMass(kg: number): string {
  if (kg >= 1_000_000_000) return `${(kg / 1_000_000_000).toFixed(2)} B kg`;
  if (kg >= 1_000_000)     return `${(kg / 1_000_000).toFixed(0)} M kg`;
  return `${kg.toLocaleString()} kg`;
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
  const { map, selectedConnectionId, updateConnection: rawUpdate, removeConnection: rawRemove, selectConnection } =
    useMapStore();
  const whTypes = useWormholeTypes();
  const now     = useNow30s();
  const canEdit = useCanEdit();
  const location = useCharacterLocation();

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

  if (!conn) return null;

  const update = (updates: Parameters<typeof updateConnection>[1]) =>
    updateConnection(conn.id, updates);

  const whSpec = conn.type ? whTypes[conn.type.toUpperCase()] : undefined;
  const massUsed = conn.massUsed ?? 0;
  const remaining = whSpec ? Math.max(0, whSpec.totalMass - massUsed) : 0;
  const pct       = whSpec ? Math.min(100, (massUsed / whSpec.totalMass) * 100) : 0;

  const addMass = (kg: number) => {
    if (!whSpec) return;
    const next = Math.max(0, massUsed + kg);
    const nextStatus = deriveStatus((whSpec.totalMass - next) / whSpec.totalMass);
    update({ massUsed: next, massStatus: nextStatus });
  };

  const resetMass = () => update({ massUsed: 0, massStatus: 'stable' });

  return (
    <aside className="system-panel">
      <div className="system-panel__header">
        <h2 className="system-panel__title">
          {src?.name ?? '?'} → {tgt?.name ?? '?'}
        </h2>
        <button className="icon-btn" onClick={() => selectConnection(null)} title="Close"><XIcon size={14} weight="bold" /></button>
      </div>

      <label className="field">
        <span>Wormhole type <WHTypeInfo code={conn.type} /></span>
        <input
          type="text"
          value={conn.type ?? ''}
          onChange={(e) => update({ type: e.target.value.toUpperCase() })}
          placeholder="K162, C247…"
        />
      </label>

      <label className="field">
        <span>Mass status</span>
        <select
          value={conn.massStatus ?? ''}
          onChange={(e) => update({ massStatus: e.target.value as MassStatus })}
        >
          <option value="stable">Stable</option>
          <option value="destabilized">Destabilized (&lt;50%)</option>
          <option value="critical">Critical (&lt;10%)</option>
        </select>
      </label>

      <label className="field">
        <span>Time status</span>
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
          <option value="fresh">Fresh</option>
          <option value="lessThan24h">Less than 1 day remaining</option>
          <option value="lessThan4h">Less than 4 hours remaining</option>
          <option value="lessThan1h">Less than 1 hour remaining</option>
          <option value="expired">Expired</option>
        </select>
      </label>

      <label className="field">
        <span>Size</span>
        <select
          value={conn.size}
          onChange={(e) => update({ size: e.target.value as ConnectionSize })}
        >
          <option value="xl">XL (Freighter)</option>
          <option value="large">Large (Battleship)</option>
          <option value="medium">Medium (Cruiser)</option>
          <option value="small">Small (Frigate)</option>
        </select>
      </label>

      {whSpec ? (
        <div className="mass-tracker">
          <div className="mass-tracker__header">
            <span className="mass-tracker__label">Mass tracker</span>
            <span className="mass-tracker__values">
              {formatMass(massUsed)} / {formatMass(whSpec.totalMass)}
            </span>
          </div>
          <div className="mass-tracker__bar">
            <div
              className={`mass-tracker__fill mass-tracker__fill--${deriveStatus(remaining / whSpec.totalMass)}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mass-tracker__remaining">
            {formatMass(remaining)} remaining · max jump {formatMass(whSpec.maxJumpMass)}
          </div>

          {(() => {
            const ship = location.ship;
            if (!ship || ship.mass == null || ship.mass <= 0) return null;
            // Ship too heavy → this hole won't let it through at all.
            if (ship.mass > whSpec.maxJumpMass) {
              return (
                <div className="mass-tracker__budget mass-tracker__budget--blocked">
                  Your {ship.typeName} ({formatMass(ship.mass)}) is too heavy for this hole
                </div>
              );
            }
            const jumps = Math.floor(remaining / ship.mass);
            return (
              <div className={`mass-tracker__budget${jumps <= 0 ? ' mass-tracker__budget--empty' : ''}`}>
                {jumps <= 0
                  ? <>Not enough mass left for one {ship.typeName} jump ({formatMass(ship.mass)})</>
                  : <>~{jumps} more {ship.typeName} jump{jumps === 1 ? '' : 's'} ({formatMass(ship.mass)} each)</>}
              </div>
            );
          })()}
          <div className="mass-tracker__buttons">
            {PRESETS
              .filter(p => p.kg <= whSpec.maxJumpMass || p.kg < 200_000_000)
              .map(p => (
                <button
                  key={p.label}
                  type="button"
                  className="sys-btn mass-tracker__btn"
                  onClick={() => addMass(p.kg)}
                >
                  {p.label}
                </button>
              ))}
            <button
              type="button"
              className="sys-btn mass-tracker__btn mass-tracker__reset"
              onClick={resetMass}
            >
              Reset
            </button>
          </div>
        </div>
      ) : conn.type ? (
        <div className="mass-tracker__hint">No mass data for type "{conn.type}".</div>
      ) : (
        <div className="mass-tracker__hint">Enter a wormhole type above to enable mass tracking.</div>
      )}

      <button
        className="btn btn--danger"
        onClick={() => { removeConnection(conn.id); }}
      >
        Remove Connection
      </button>
    </aside>
  );
}
