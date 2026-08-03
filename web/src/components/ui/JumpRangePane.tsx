import { useState } from 'react';
import { useJumpRangeStore } from '../../store/jumpRangeStore';
import { useJumpRange, useJdcLevel } from '../../hooks/useJumpRange';
import { JUMP_CLASSES, jumpRange } from '../../data/jumpDrives';

// PROTOTYPE Jump Range overlay panel. Pick a staging system (right-click a system
// -> "Jump range from here"), set your JDC skill, and see every low/null system
// within jump range — filterable by ship class — plus the reachable systems get
// highlighted on the map (via jumpRangeStore -> SystemNode).
export function JumpRangePane() {
  const [jdc, setJdc] = useJdcLevel();
  const stagingName = useJumpRangeStore((s) => s.stagingName);
  const stagingId   = useJumpRangeStore((s) => s.stagingId);
  const setStaging  = useJumpRangeStore((s) => s.setStaging);
  const { targets, loading } = useJumpRange();
  const [filter, setFilter] = useState<string | null>(null); // class key, null = all

  const filterRange = filter ? jumpRange(JUMP_CLASSES.find((c) => c.key === filter)!.base, jdc) : Infinity;
  const shown = targets.filter((t) => t.ly <= filterRange);

  if (stagingId == null) {
    return (
      <div className="map-sidebar__hint">
        Right-click a system on the map and choose <strong>“Jump range from here”</strong> to
        see every low/null system within jump range of it.
      </div>
    );
  }

  return (
    <>
      <div className="map-sidebar__row" style={{ justifyContent: 'space-between' }}>
        <span className="map-sidebar__label">Staging: <strong>{stagingName ?? stagingId}</strong></span>
        <button type="button" className="toolbar__toggle" onClick={() => setStaging(null)}>Clear</button>
      </div>

      <label className="map-sidebar__row" style={{ gap: 8 }}>
        <span className="map-sidebar__label">Jump Drive Calibration</span>
        <select value={jdc} onChange={(e) => setJdc(Number(e.target.value))}>
          {[0, 1, 2, 3, 4, 5].map((l) => <option key={l} value={l}>JDC {['0', 'I', 'II', 'III', 'IV', 'V'][l]}</option>)}
        </select>
      </label>

      {/* Class filter chips — each shows its effective range at this JDC */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '6px 0' }}>
        <Chip active={filter === null} onClick={() => setFilter(null)} color="#8aa" label={`All (${targets.length})`} />
        {JUMP_CLASSES.map((c) => (
          <Chip
            key={c.key}
            active={filter === c.key}
            onClick={() => setFilter(filter === c.key ? null : c.key)}
            color={c.color}
            label={`${c.label.split(' ')[0]} ${jumpRange(c.base, jdc).toFixed(1)}ly`}
          />
        ))}
      </div>

      {loading && <div className="map-sidebar__hint">Calculating…</div>}
      {!loading && (
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          <div className="map-sidebar__hint">{shown.length} systems in range</div>
          {shown.map((t) => {
            const reach = JUMP_CLASSES.filter((c) => t.ly <= jumpRange(c.base, jdc));
            return (
              <div key={t.eveSystemId} className="map-sidebar__row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.name}{' '}
                  <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{t.systemClass} · {t.regionName ?? '?'}</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  {reach.map((c) => (
                    <span key={c.key} title={c.label}
                      style={{ width: 8, height: 8, borderRadius: '50%', background: c.color, display: 'inline-block' }} />
                  ))}
                  <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 44, textAlign: 'right' }}>{t.ly.toFixed(2)} ly</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function Chip({ active, onClick, color, label }: { active: boolean; onClick: () => void; color: string; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: 11, padding: '2px 7px', borderRadius: 10, cursor: 'pointer',
        border: `1px solid ${color}`,
        background: active ? color : 'transparent',
        color: active ? '#0d1117' : color,
        fontWeight: 600,
      }}
    >{label}</button>
  );
}
