import { useState } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from '../../icons';
import { api } from '../../api/client';
import { useEsiSearch, systemResultLabel } from '../../hooks/useEsiSearch';
import { useJdcLevel } from '../../hooks/useJumpRange';
import { useUserSetting } from '../../hooks/useUserSetting';
import { JUMP_CLASSES, jumpRange, estimateFuel } from '../../data/jumpDrives';

// PROTOTYPE Jump Planner (phase 1b — inputs + route list). Pick source/dest, a
// ship class + skills (JDC / Jump Fuel Conservation / Jump Freighters), and an
// objective (fewest jumps or least fuel), and plot a multi-hop jump route with
// totals. English-only for now; i18n + the route map + save come next.
interface RouteHop { eveSystemId: number; name: string; systemClass: string; lyFromPrev: number }
interface RouteResp { hasCoords: boolean; route: { hops: RouteHop[]; jumps: number; totalLy: number } | null }
type Picked = { id: number; name: string } | null;

export function JumpPlannerModal({ onClose }: { onClose: () => void }) {
  const [from, setFrom] = useState<Picked>(null);
  const [to, setTo]     = useState<Picked>(null);
  const [shipClass, setShipClass] = useUserSetting<string>('nexum.jump.planShip', 'blops');
  const [jdc]      = useJdcLevel();
  const [jfc, setJfc]         = useUserSetting<number>('nexum.jump.jfc', 5);
  const [jfSkill, setJfSkill] = useUserSetting<number>('nexum.jump.jf', 5);
  const [objective, setObjective] = useState<'hops' | 'fuel'>('hops');
  const [result, setResult]   = useState<RouteResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const cls = JUMP_CLASSES.find((c) => c.key === shipClass) ?? JUMP_CLASSES[0];
  const rangeLy = jumpRange(cls.base, jdc);
  const isJf = shipClass === 'jf';

  const plan = async () => {
    if (!from || !to) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const r = await api<RouteResp>(
        `/api/systems/jump-route?from=${from.id}&to=${to.id}&rangeLy=${rangeLy.toFixed(2)}&objective=${objective}`,
      );
      setResult(r);
      if (!r.hasCoords) setError('This deployment doesn\'t have 3D coordinates loaded (run the coordinate backfill).');
      else if (!r.route) setError('No route within range — try a longer-range ship or higher JDC.');
    } catch { setError('Routing failed.'); }
    finally { setLoading(false); }
  };

  const fuel = result?.route ? estimateFuel(result.route.totalLy, shipClass, jfc, jfSkill) : 0;

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 'min(880px, 96vw)', width: '96vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal__header">
          <h2 className="modal__title">Jump Planner</h2>
          <button className="icon-btn" onClick={onClose} title="Close"><XIcon size={14} weight="bold" /></button>
        </div>
        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="From (low/null)" value={from} onPick={setFrom} />
            <Field label="To (low/null)"   value={to}   onPick={setTo} />
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
            <Labelled label="Ship">
              <select value={shipClass} onChange={(e) => setShipClass(e.target.value)}>
                {JUMP_CLASSES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </Labelled>
            <Labelled label="JDC (range)"><Skill value={jdc} readOnly /></Labelled>
            <Labelled label="Jump Fuel Conservation"><Skill value={jfc} onChange={setJfc} /></Labelled>
            {isJf && <Labelled label="Jump Freighters"><Skill value={jfSkill} onChange={setJfSkill} /></Labelled>}
            <span style={{ color: 'var(--text-subtle)', fontSize: 12 }}>Range: <strong>{rangeLy.toFixed(1)} ly</strong></span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ display: 'inline-flex', border: '1px solid #30363d', borderRadius: 6, overflow: 'hidden' }}>
              {(['hops', 'fuel'] as const).map((o) => (
                <button key={o} type="button" onClick={() => setObjective(o)}
                  className="toolbar__toggle" style={{ borderRadius: 0, background: objective === o ? 'var(--accent, #2f6fed)' : 'transparent', color: objective === o ? '#fff' : undefined }}>
                  {o === 'hops' ? 'Fewest jumps' : 'Least fuel'}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn--primary" disabled={!from || !to || loading} onClick={plan}>
              {loading ? 'Planning…' : 'Plan route'}
            </button>
          </div>

          {error && <div style={{ color: 'var(--cv-conn-expired)', fontSize: 13 }}>{error}</div>}

          {result?.route && (
            <div style={{ borderTop: '1px solid #30363d', paddingTop: 10 }}>
              <div style={{ fontSize: 14, marginBottom: 8 }}>
                <strong>{result.route.jumps}</strong> jumps · <strong>{result.route.totalLy.toFixed(1)}</strong> ly ·
                {' '}~<strong>{fuel.toLocaleString()}</strong> isotopes <span style={{ color: 'var(--text-faint)' }}>(estimate)</span>
              </div>
              <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {result.route.hops.map((h, i) => (
                  <li key={h.eveSystemId} style={{ fontSize: 13 }}>
                    {h.name} <span style={{ color: 'var(--text-faint)' }}>{h.systemClass}</span>
                    {i > 0 && <span style={{ color: 'var(--text-subtle)' }}> — {h.lyFromPrev.toFixed(2)} ly</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 }}>
      <span style={{ color: 'var(--text-subtle)' }}>{label}</span>
      {children}
    </label>
  );
}

function Skill({ value, onChange, readOnly }: { value: number; onChange?: (n: number) => void; readOnly?: boolean }) {
  return (
    <select value={value} disabled={readOnly} onChange={(e) => onChange?.(Number(e.target.value))}>
      {[0, 1, 2, 3, 4, 5].map((l) => <option key={l} value={l}>{['0', 'I', 'II', 'III', 'IV', 'V'][l]}</option>)}
    </select>
  );
}

// LS/NS system search field (label + input + dropdown), controlled by a picked value.
function Field({ label, value, onPick }: { label: string; value: Picked; onPick: (v: Picked) => void }) {
  const [query, setQuery] = useState('');
  const { results, loading } = useEsiSearch(query);
  const kspace = results.filter((r) => r.systemClass === 'LS' || r.systemClass === 'NS');
  const show = query.trim().length >= 2 && (kspace.length > 0 || loading);
  return (
    <div style={{ position: 'relative' }}>
      <div style={{ fontSize: 12, color: 'var(--text-subtle)', marginBottom: 3 }}>{label}</div>
      {value ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, border: '1px solid #30363d', borderRadius: 6, padding: '5px 8px' }}>
          <strong>{value.name}</strong>
          <button type="button" className="icon-btn" onClick={() => onPick(null)} title="Change"><XIcon size={12} /></button>
        </div>
      ) : (
        <input className="chains-new__name" style={{ width: '100%' }} type="text" value={query}
          placeholder="Search a system…" onChange={(e) => setQuery(e.target.value)} />
      )}
      {!value && show && (
        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, maxHeight: 220, overflowY: 'auto', background: 'var(--bg-elevated, #161b22)', border: '1px solid #30363d', borderRadius: 6 }}>
          {loading && <div className="map-sidebar__hint" style={{ padding: '6px 8px' }}>Searching…</div>}
          {kspace.map((r) => (
            <button key={r.id} type="button" onClick={() => { onPick({ id: r.id, name: r.name }); setQuery(''); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 13 }}>
              {systemResultLabel(r)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
