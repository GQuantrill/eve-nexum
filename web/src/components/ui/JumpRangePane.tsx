import { useState } from 'react';
import { useJumpRangeStore } from '../../store/jumpRangeStore';
import { useJumpRange, useJdcLevel } from '../../hooks/useJumpRange';
import { JUMP_CLASSES, jumpRange } from '../../data/jumpDrives';
import { useEsiSearch, systemResultLabel } from '../../hooks/useEsiSearch';

// PROTOTYPE Jump Range overlay panel. Pick a staging system (right-click a system
// -> "Jump range from here"), set your JDC skill, and see every low/null system
// within jump range — filterable by ship class — plus the reachable systems get
// highlighted on the map (via jumpRangeStore -> SystemNode).
export function JumpRangePane() {
  const [jdc, setJdc] = useJdcLevel();
  const stagingName = useJumpRangeStore((s) => s.stagingName);
  const stagingId   = useJumpRangeStore((s) => s.stagingId);
  const setStaging  = useJumpRangeStore((s) => s.setStaging);
  const { targets, loading, hasCoords } = useJumpRange();
  const filter    = useJumpRangeStore((s) => s.filterClass);   // class key, null = all
  const setFilter = useJumpRangeStore((s) => s.setFilterClass);

  const filterRange = filter ? jumpRange(JUMP_CLASSES.find((c) => c.key === filter)!.base, jdc) : Infinity;
  const shown = targets.filter((t) => t.ly <= filterRange);

  return (
    <>
      <StagingPicker onPick={(id, name) => setStaging(id, name)} />

      {stagingId == null && (
        <div className="map-sidebar__hint">
          Search a staging system above, or right-click a system on the map and choose
          <strong> “Jump range from here”</strong>.
        </div>
      )}

      {stagingId != null && (<>
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
      {!loading && !hasCoords && (
        <div className="map-sidebar__hint" style={{ color: 'var(--cv-conn-expired)' }}>
          This deployment doesn't have 3D system coordinates loaded, which jump-range
          needs. Run the SDE coordinate backfill on the server
          (<code>npx tsx scripts/backfill-coords.ts</code>) or re-run <code>setup-db</code>,
          then reload.
        </div>
      )}
      {!loading && hasCoords && (
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
      </>)}
    </>
  );
}

// Search any low/null EVE system by name (on-map or not) to use as the staging point.
function StagingPicker({ onPick }: { onPick: (id: number, name: string) => void }) {
  const [query, setQuery] = useState('');
  const { results, loading } = useEsiSearch(query);
  const kspace = results.filter((r) => r.systemClass === 'LS' || r.systemClass === 'NS');
  const show = query.trim().length >= 2 && (kspace.length > 0 || loading);
  return (
    <div style={{ position: 'relative', marginBottom: 4 }}>
      <input
        className="chains-new__name"
        style={{ width: '100%' }}
        type="text"
        value={query}
        placeholder="Staging system (low/null)…"
        onChange={(e) => setQuery(e.target.value)}
      />
      {show && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, maxHeight: 220,
          overflowY: 'auto', background: 'var(--bg-elevated, #161b22)', border: '1px solid #30363d', borderRadius: 6,
        }}>
          {loading && <div className="map-sidebar__hint" style={{ padding: '6px 8px' }}>Searching…</div>}
          {kspace.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => { onPick(r.id, r.name); setQuery(''); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px',
                background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 13,
              }}
            >{systemResultLabel(r)}</button>
          ))}
        </div>
      )}
    </div>
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
