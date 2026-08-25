import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useJumpRangeStore } from '../../store/jumpRangeStore';
import { useJdcLevel } from '../../hooks/useJumpRange';
import { JUMP_CLASSES, jumpRange } from '../../data/jumpDrives';
import { useEsiSearch, systemResultLabel } from '../../hooks/useEsiSearch';

// Jump Range overlay panel. Pick a staging system (search above, or right-click a
// system -> "Jump range from here"), set your JDC skill, and see every low/null
// system within jump range — filterable by ship class — plus the reachable systems
// highlight on the map (via jumpRangeStore -> SystemNode). Ship-class names, the
// JDC skill name and "ly" stay English (EVE terms).
export function JumpRangePane() {
  const { t } = useTranslation();
  const [jdc, setJdc] = useJdcLevel();
  const stagingName = useJumpRangeStore((s) => s.stagingName);
  const stagingId   = useJumpRangeStore((s) => s.stagingId);
  const setStaging  = useJumpRangeStore((s) => s.setStaging);
  // Results are computed by the globally-mounted useJumpRange (in MapCanvas) and
  // read off the store here, so the overlay works with the pane closed too.
  const targets   = useJumpRangeStore((s) => s.targets);
  const loading   = useJumpRangeStore((s) => s.loading);
  const hasCoords = useJumpRangeStore((s) => s.hasCoords);
  const filter    = useJumpRangeStore((s) => s.filterClass);   // class key, null = all
  const setFilter = useJumpRangeStore((s) => s.setFilterClass);

  const filterRange = filter ? jumpRange(JUMP_CLASSES.find((c) => c.key === filter)!.base, jdc) : Infinity;
  const shown = targets.filter((t2) => t2.ly <= filterRange);

  return (
    <>
      <StagingPicker onPick={(id, name) => setStaging(id, name)} />

      {stagingId == null && (
        <div className="map-sidebar__hint">{t('mapSidebar.jumpRange.pickHint')}</div>
      )}

      {stagingId != null && (<>
      <div className="map-sidebar__row" style={{ justifyContent: 'space-between' }}>
        <span className="map-sidebar__label">{t('mapSidebar.jumpRange.staging')}: <strong>{stagingName ?? stagingId}</strong></span>
        <button type="button" className="toolbar__toggle" onClick={() => setStaging(null)}>{t('mapSidebar.jumpRange.clear')}</button>
      </div>

      <label className="map-sidebar__row" style={{ gap: 8 }}>
        <span className="map-sidebar__label">Jump Drive Calibration</span>
        <select value={jdc} onChange={(e) => setJdc(Number(e.target.value))}>
          {[0, 1, 2, 3, 4, 5].map((l) => <option key={l} value={l}>JDC {['0', 'I', 'II', 'III', 'IV', 'V'][l]}</option>)}
        </select>
      </label>

      {/* Class filter chips — each shows its effective range at this JDC */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '6px 0' }}>
        <Chip active={filter === null} onClick={() => setFilter(null)} color="#8aa" label={`${t('mapSidebar.jumpRange.all')} (${targets.length})`} />
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

      {/* Colour legend: dot colour -> ship class (near = orange … far = blue). */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, margin: '2px 0 6px', fontSize: 10, color: 'var(--text-faint)' }}>
        <span>{t('mapSidebar.jumpRange.legend')}</span>
        {JUMP_CLASSES.map((c) => (
          <span key={c.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: c.color, display: 'inline-block' }} />
            {c.label.split(' ')[0]}
          </span>
        ))}
      </div>

      {loading && <div className="map-sidebar__hint">{t('mapSidebar.jumpRange.calculating')}</div>}
      {!loading && !hasCoords && (
        <div className="map-sidebar__hint" style={{ color: 'var(--cv-conn-expired)' }}>
          {t('mapSidebar.jumpRange.noCoords')}
        </div>
      )}
      {!loading && hasCoords && (
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          <div className="map-sidebar__hint">{t('mapSidebar.jumpRange.inRange', { count: shown.length })}</div>
          {shown.map((t2) => {
            const reach = JUMP_CLASSES.filter((c) => t2.ly <= jumpRange(c.base, jdc));
            return (
              <div key={t2.eveSystemId} className="map-sidebar__row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t2.name}{' '}
                  <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{t2.systemClass}</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  {reach.map((c) => (
                    <span key={c.key} title={c.label}
                      style={{ width: 8, height: 8, borderRadius: '50%', background: c.color, display: 'inline-block' }} />
                  ))}
                  <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 44, textAlign: 'right' }}>{t2.ly.toFixed(2)} ly</span>
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
  const { t } = useTranslation();
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
        placeholder={t('mapSidebar.jumpRange.stagingPlaceholder')}
        onChange={(e) => setQuery(e.target.value)}
      />
      {show && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, maxHeight: 220,
          overflowY: 'auto', background: 'var(--bg-elevated, #161b22)', border: '1px solid #30363d', borderRadius: 6,
        }}>
          {loading && <div className="map-sidebar__hint" style={{ padding: '6px 8px' }}>{t('mapSidebar.jumpRange.searching')}</div>}
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
