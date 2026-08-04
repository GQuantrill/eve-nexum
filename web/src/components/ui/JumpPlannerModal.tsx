import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '../../icons';
import { Select } from './Select';
import { api } from '../../api/client';
import { useEsiSearch, systemResultLabel } from '../../hooks/useEsiSearch';
import { useJdcLevel } from '../../hooks/useJumpRange';
import { useUserSetting } from '../../hooks/useUserSetting';
import { JUMP_CLASSES, jumpRange, estimateFuel } from '../../data/jumpDrives';

// Jump Planner. Pick source/dest, a ship class + skills (JDC / Jump Fuel
// Conservation / Jump Freighters) and an objective (fewest jumps or least fuel),
// plot a multi-hop jump route with totals + a route map, and save/load plans.
// EVE skill names, ship-class labels and "ly" stay English; the rest is i18n'd.
interface RouteHop { eveSystemId: number; name: string; systemClass: string; lyFromPrev: number; x: number; y: number }
interface RouteResp { hasCoords: boolean; route: { hops: RouteHop[]; jumps: number; totalLy: number } | null }
interface SavedPlan { id: string; name: string; fromEveId: number; toEveId: number; fromName: string | null; toName: string | null; shipClass: string; objective: 'hops' | 'fuel' }
type Picked = { id: number; name: string } | null;

export function JumpPlannerModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [from, setFrom] = useState<Picked>(null);
  const [to, setTo]     = useState<Picked>(null);
  const [shipClass, setShipClass] = useUserSetting<string>('nexum.jump.planShip', 'blops');
  const [jdc, setJdc] = useJdcLevel();
  const [jfc, setJfc]         = useUserSetting<number>('nexum.jump.jfc', 5);
  const [jfSkill, setJfSkill] = useUserSetting<number>('nexum.jump.jf', 5);
  const [objective, setObjective] = useState<'hops' | 'fuel'>('hops');
  const [result, setResult]   = useState<RouteResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [plans, setPlans]     = useState<SavedPlan[]>([]);
  const [saveName, setSaveName] = useState('');

  const refreshPlans = () => { api<SavedPlan[]>('/api/jump-plans').then(setPlans).catch(() => {}); };
  useEffect(() => { refreshPlans(); }, []);
  const savePlan = async () => {
    if (!from || !to || !saveName.trim()) return;
    await api('/api/jump-plans', { method: 'POST', body: JSON.stringify({ name: saveName.trim(), fromEveId: from.id, toEveId: to.id, shipClass, objective }) }).catch(() => {});
    setSaveName(''); refreshPlans();
  };
  const loadPlan = (p: SavedPlan) => {
    setFrom({ id: p.fromEveId, name: p.fromName ?? String(p.fromEveId) });
    setTo({ id: p.toEveId, name: p.toName ?? String(p.toEveId) });
    setShipClass(p.shipClass); setObjective(p.objective); setResult(null); setError(null);
  };
  const deletePlan = async (id: string) => { await api(`/api/jump-plans/${id}`, { method: 'DELETE' }).catch(() => {}); refreshPlans(); };

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
      if (!r.hasCoords) setError(t('jumpPlanner.errNoCoords'));
      else if (!r.route) setError(t('jumpPlanner.errNoRoute'));
    } catch { setError(t('jumpPlanner.errFailed')); }
    finally { setLoading(false); }
  };

  const fuel = result?.route ? estimateFuel(result.route.totalLy, shipClass, jfc, jfSkill) : 0;

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 'min(880px, 96vw)', width: '96vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal__header">
          <h2 className="modal__title">{t('jumpPlanner.title')}</h2>
          <button className="icon-btn" onClick={onClose} title={t('jumpPlanner.close')}><XIcon size={14} weight="bold" /></button>
        </div>
        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-subtle)', marginBottom: 4 }}>{t('jumpPlanner.savedHdr')}</div>
            {plans.length === 0 ? (
              <div className="map-sidebar__hint" style={{ margin: 0 }}>{t('jumpPlanner.savedEmpty')}</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {plans.map((p) => (
                  <span key={p.id} style={{ display: 'inline-flex', alignItems: 'stretch', border: '1px solid #30363d', borderRadius: 6, overflow: 'hidden' }}>
                    <button type="button" onClick={() => loadPlan(p)} title={t('jumpPlanner.loadPlan')}
                      style={{ background: 'var(--surface-panel, #1c2333)', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 12, padding: '5px 9px' }}>
                      <strong>{p.name}</strong>{'  '}
                      <span style={{ color: 'var(--text-faint)' }}>{p.fromName ?? p.fromEveId} → {p.toName ?? p.toEveId}</span>
                    </button>
                    <button type="button" onClick={() => deletePlan(p.id)} className="icon-btn" title={t('jumpPlanner.deletePlan')}
                      style={{ padding: '0 7px', borderLeft: '1px solid #30363d' }}><XIcon size={11} /></button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label={t('jumpPlanner.from')} value={from} onPick={setFrom} />
            <Field label={t('jumpPlanner.to')}   value={to}   onPick={setTo} />
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
            <Labelled label={t('jumpPlanner.ship')}>
              <Select value={shipClass} onChange={setShipClass} ariaLabel={t('jumpPlanner.ship')}
                options={JUMP_CLASSES.map((c) => ({ value: c.key, label: c.label }))} />
            </Labelled>
            <Labelled label="JDC (range)"><Skill value={jdc} onChange={setJdc} ariaLabel="Jump Drive Calibration" /></Labelled>
            <Labelled label="Jump Fuel Conservation"><Skill value={jfc} onChange={setJfc} ariaLabel="Jump Fuel Conservation" /></Labelled>
            {isJf && <Labelled label="Jump Freighters"><Skill value={jfSkill} onChange={setJfSkill} ariaLabel="Jump Freighters" /></Labelled>}
            <span style={{ color: 'var(--text-subtle)', fontSize: 12 }}>{t('jumpPlanner.range')}: <strong>{rangeLy.toFixed(1)} ly</strong></span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ display: 'inline-flex', border: '1px solid #30363d', borderRadius: 6, overflow: 'hidden' }}>
              {(['hops', 'fuel'] as const).map((o) => (
                <button key={o} type="button" onClick={() => setObjective(o)}
                  className="toolbar__toggle" style={{ borderRadius: 0, background: objective === o ? 'var(--accent, #2f6fed)' : 'transparent', color: objective === o ? '#fff' : undefined }}>
                  {o === 'hops' ? t('jumpPlanner.fewestJumps') : t('jumpPlanner.leastFuel')}
                </button>
              ))}
            </div>
            <button type="button" className="btn btn--primary" disabled={!from || !to || loading} onClick={plan}>
              {loading ? t('jumpPlanner.planning') : t('jumpPlanner.planRoute')}
            </button>
            <span style={{ flex: 1 }} />
            <input className="chains-new__name" style={{ width: 150 }} placeholder={t('jumpPlanner.nameToSave')}
              value={saveName} onChange={(e) => setSaveName(e.target.value)} />
            <button type="button" className="btn btn--ghost" disabled={!from || !to || !saveName.trim()} onClick={savePlan}>{t('jumpPlanner.save')}</button>
          </div>

          {error && <div style={{ color: 'var(--cv-conn-expired)', fontSize: 13 }}>{error}</div>}

          {result?.route && (
            <div style={{ borderTop: '1px solid #30363d', paddingTop: 10 }}>
              <div style={{ fontSize: 14, marginBottom: 8 }}>
                {t('jumpPlanner.result', { jumps: result.route.jumps, ly: result.route.totalLy.toFixed(1), fuel: fuel.toLocaleString() })}
              </div>
              <RouteMap hops={result.route.hops} />
              <ol style={{ margin: '10px 0 0', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 2 }}>
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

// Plots the route on CCP's 2D star-map projection — aspect-preserving, centred,
// with a line through the hops and start/end marked. Labels are best-effort.
function RouteMap({ hops }: { hops: RouteHop[] }) {
  if (hops.length < 2) return null;
  const W = 820, H = 300, PAD = 34;
  const xs = hops.map((h) => h.x), ys = hops.map((h) => h.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
  const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const ox = (W - spanX * scale) / 2, oy = (H - spanY * scale) / 2;
  const sx = (x: number) => ox + (x - minX) * scale;
  const sy = (y: number) => oy + (y - minY) * scale;   // pos2d y is screen-down already
  const pts = hops.map((h) => ({ x: sx(h.x), y: sy(h.y), h }));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 300, background: '#0d1117', borderRadius: 6 }}>
      <polyline points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#56b4e9" strokeWidth={2} opacity={0.85} />
      {pts.map((p, i) => {
        const first = i === 0, last = i === pts.length - 1;
        return (
          <g key={p.h.eveSystemId}>
            <circle cx={p.x} cy={p.y} r={first || last ? 6 : 4}
              fill={first ? '#3ddc84' : last ? '#e69f00' : '#161b22'} stroke="#56b4e9" strokeWidth={2} />
            {(first || last || pts.length <= 12) && (
              <text x={p.x} y={p.y - 9} fill="#c9d1d9" fontSize={11} textAnchor="middle">{p.h.name}</text>
            )}
          </g>
        );
      })}
    </svg>
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

const SKILL_LABELS = ['0', 'I', 'II', 'III', 'IV', 'V'];
function Skill({ value, onChange, readOnly, ariaLabel }: { value: number; onChange?: (n: number) => void; readOnly?: boolean; ariaLabel?: string }) {
  return (
    <Select value={String(value)} onChange={(v) => onChange?.(Number(v))} disabled={readOnly} ariaLabel={ariaLabel}
      options={[0, 1, 2, 3, 4, 5].map((l) => ({ value: String(l), label: SKILL_LABELS[l] }))} />
  );
}

// LS/NS system search field (label + input + dropdown), controlled by a picked value.
function Field({ label, value, onPick }: { label: string; value: Picked; onPick: (v: Picked) => void }) {
  const { t } = useTranslation();
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
          <button type="button" className="icon-btn" onClick={() => onPick(null)} title={t('jumpPlanner.change')}><XIcon size={12} /></button>
        </div>
      ) : (
        <input className="chains-new__name" style={{ width: '100%' }} type="text" value={query}
          placeholder={t('jumpPlanner.searchSystem')} onChange={(e) => setQuery(e.target.value)} />
      )}
      {!value && show && (
        // Same two-column layout as the map's Add System search: name left,
        // region (systemResultLabel) right — reuses the shared search-results CSS.
        <ul className="search-results">
          {loading && <li className="search-results__item" style={{ cursor: 'default', opacity: 0.6 }}>{t('jumpPlanner.searching')}</li>}
          {kspace.map((r) => (
            <li key={r.id} className="search-results__item" role="option"
              onMouseDown={(e) => { e.preventDefault(); onPick({ id: r.id, name: r.name }); setQuery(''); }}>
              <span>{r.name}</span>
              <span className="search-results__class">{systemResultLabel(r)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
