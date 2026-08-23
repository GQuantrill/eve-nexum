import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon, CaretUpIcon, CaretDownIcon } from '../../icons';
import { Select } from './Select';
import { api } from '../../api/client';
import { useEsiSearch, systemResultLabel } from '../../hooks/useEsiSearch';
import { useJdcLevel } from '../../hooks/useJumpRange';
import { useUserSetting } from '../../hooks/useUserSetting';
import { JUMP_CLASSES, jumpRange, estimateFuel, computeFatigue, formatMinutes } from '../../data/jumpDrives';
import { dockState } from '../../data/dockingRules';

// Jump Planner. Pick source/dest, a ship class + skills (JDC / Jump Fuel
// Conservation / Jump Freighters) and an objective (fewest jumps or least fuel),
// plot a multi-hop jump route with totals + a route map, and save/load plans.
// EVE skill names, ship-class labels and "ly" stay English; the rest is i18n'd.
interface RouteHop { eveSystemId: number; name: string; systemClass: string; lyFromPrev: number; x: number; y: number; viaGate?: boolean }
interface RouteResp { hasCoords: boolean; route: { hops: RouteHop[]; jumps: number; gates: number; totalLy: number } | null }
interface SavedPlan { id: string; name: string; fromEveId: number; toEveId: number; fromName: string | null; toName: string | null; shipClass: string; objective: 'hops' | 'fuel'; avoid: { id: number; name: string }[]; waypoints: { id: number; name: string }[]; preferLevel: string }
interface CorpStructure { key: string; name: string; typeName: string; solarSystemId: number | null; systemName: string | null; systemClass: string | null; source: 'corp' | 'map' }
type Picked = { id: number; name: string; structureType?: string | null } | null;

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
  const [structures, setStructures] = useState<CorpStructure[]>([]);
  const [avoid, setAvoid] = useState<{ id: number; name: string }[]>([]);
  const [waypoints, setWaypoints] = useState<{ id: number; name: string }[]>([]);
  const [preferLevel, setPreferLevel] = useUserSetting<string>('nexum.jump.preferLevel', 'off');
  // Opt-in: let the route take regional (cross-region) stargate jumps. Off by
  // default — these gates are chokepoints and are often camped.
  const [regionalGates, setRegionalGates] = useUserSetting<boolean>('nexum.jump.regionalGates', false);

  const refreshPlans = () => { api<SavedPlan[]>('/api/jump-plans').then(setPlans).catch(() => {}); };
  // Structures (corp ESI-synced on login + map-tagged) feed the From/To search;
  // no manual sync control — role-holders' logins populate the corp set.
  const loadStructures = () => { api<CorpStructure[]>('/api/structures').then(setStructures).catch(() => {}); };
  useEffect(() => { refreshPlans(); loadStructures(); }, []);
  const savePlan = async () => {
    if (!from || !to || !saveName.trim()) return;
    await api('/api/jump-plans', { method: 'POST', body: JSON.stringify({
      name: saveName.trim(), fromEveId: from.id, toEveId: to.id, shipClass, objective,
      avoid: avoid.map((a) => a.id), waypoints: waypoints.map((w) => w.id), preferLevel,
    }) }).catch(() => {});
    setSaveName(''); refreshPlans();
  };
  const loadPlan = (p: SavedPlan) => {
    setFrom({ id: p.fromEveId, name: p.fromName ?? String(p.fromEveId) });
    setTo({ id: p.toEveId, name: p.toName ?? String(p.toEveId) });
    setShipClass(p.shipClass); setObjective(p.objective);
    setAvoid(p.avoid ?? []); setWaypoints(p.waypoints ?? []); setPreferLevel(p.preferLevel ?? 'off');
    setResult(null); setError(null);
  };
  const deletePlan = async (id: string) => { await api(`/api/jump-plans/${id}`, { method: 'DELETE' }).catch(() => {}); refreshPlans(); };
  const moveWaypoint = (i: number, dir: -1 | 1) => setWaypoints((w) => {
    const j = i + dir;
    if (j < 0 || j >= w.length) return w;
    const c = [...w]; [c[i], c[j]] = [c[j], c[i]]; return c;
  });

  const cls = JUMP_CLASSES.find((c) => c.key === shipClass) ?? JUMP_CLASSES[0];
  const rangeLy = jumpRange(cls.base, jdc);
  const isJf = shipClass === 'jf';

  // Docking check for structure endpoints (informational — never blocks routing).
  // undock = hard "can't dock", tether = softer "can arrive safe but not dock";
  // unknown structure type stays silent.
  const dockWarn = ([from, to] as Picked[])
    .map((p) => {
      if (!p?.structureType) return null;
      const st = dockState(shipClass, p.structureType);
      const vars = { ship: cls.label, name: p.name, type: p.structureType };
      if (st === 'undock') return { bad: true,  msg: t('jumpPlanner.dockCant', vars) };
      if (st === 'tether') return { bad: false, msg: t('jumpPlanner.dockTether', vars) };
      return null;
    })
    .filter((w): w is { bad: boolean; msg: string } => w !== null);

  const plan = async () => {
    if (!from || !to) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const params = new URLSearchParams({
        from: String(from.id), to: String(to.id), rangeLy: rangeLy.toFixed(2), objective,
      });
      if (waypoints.length) params.set('via', waypoints.map((w) => w.id).join(','));
      if (avoid.length) params.set('avoid', avoid.map((a) => a.id).join(','));
      if (regionalGates) params.set('regionalGates', '1');
      if (preferLevel !== 'off') {
        params.set('preferStations', preferLevel);
        // Pass the caller's structure systems so they count as "safe" too.
        const safe = [...new Set(structures.map((s) => s.solarSystemId).filter((v): v is number => v != null))];
        if (safe.length) params.set('safe', safe.join(','));
      }
      const r = await api<RouteResp>(`/api/systems/jump-route?${params.toString()}`);
      setResult(r);
      if (!r.hasCoords) setError(t('jumpPlanner.errNoCoords'));
      else if (!r.route) setError(t('jumpPlanner.errNoRoute'));
    } catch { setError(t('jumpPlanner.errFailed')); }
    finally { setLoading(false); }
  };

  const fuel = result?.route ? estimateFuel(result.route.totalLy, shipClass, jfc, jfSkill) : 0;
  const fatigue = result?.route ? computeFatigue(result.route.hops) : null;

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
            <Field label={t('jumpPlanner.from')} value={from} onPick={setFrom} structures={structures} />
            <Field label={t('jumpPlanner.to')}   value={to}   onPick={setTo}   structures={structures} />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-subtle)', marginBottom: 4 }}>{t('jumpPlanner.waypoints')}</div>
            {waypoints.length > 0 && (
              <ol style={{ margin: '0 0 6px', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {waypoints.map((w, i) => (
                  <li key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 4, border: '1px solid #30363d', borderRadius: 6, padding: '3px 6px 3px 10px', fontSize: 13 }}>
                    <span style={{ flex: 1 }}>{i + 1}. {w.name}</span>
                    <button type="button" className="icon-btn" title={t('jumpPlanner.moveUp')} disabled={i === 0} onClick={() => moveWaypoint(i, -1)}><CaretUpIcon size={12} /></button>
                    <button type="button" className="icon-btn" title={t('jumpPlanner.moveDown')} disabled={i === waypoints.length - 1} onClick={() => moveWaypoint(i, 1)}><CaretDownIcon size={12} /></button>
                    <button type="button" className="icon-btn" onClick={() => setWaypoints((v) => v.filter((x) => x.id !== w.id))}><XIcon size={11} /></button>
                  </li>
                ))}
              </ol>
            )}
            <AddSystemSearch placeholder={t('jumpPlanner.waypointAdd')} onAdd={(s) => setWaypoints((w) => (w.some((x) => x.id === s.id) ? w : [...w, s]))} />
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

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 260px', minWidth: 220 }}>
              <div style={{ fontSize: 12, color: 'var(--text-subtle)', marginBottom: 4 }}>{t('jumpPlanner.avoid')}</div>
              <AddSystemSearch placeholder={t('jumpPlanner.avoidAdd')} onAdd={(s) => setAvoid((a) => (a.some((x) => x.id === s.id) ? a : [...a, s]))} />
              {avoid.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {avoid.map((a) => (
                    <span key={a.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: '1px solid #30363d', borderRadius: 12, padding: '2px 4px 2px 9px', fontSize: 12 }}>
                      {a.name}
                      <button type="button" className="icon-btn" onClick={() => setAvoid((v) => v.filter((x) => x.id !== a.id))}><XIcon size={11} /></button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <Labelled label={t('jumpPlanner.preferStations')}>
              <Select value={preferLevel} onChange={setPreferLevel} ariaLabel={t('jumpPlanner.preferStations')}
                title={t('jumpPlanner.preferHelp')}
                options={[
                  { value: 'off', label: t('jumpPlanner.preferOff') },
                  { value: 'prefer', label: t('jumpPlanner.preferPrefer') },
                  { value: 'strong', label: t('jumpPlanner.preferStrong') },
                ]} />
            </Labelled>
            <Labelled label={t('jumpPlanner.regionalGates')}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' }}
                title={t('jumpPlanner.regionalGatesHelp')}>
                <input type="checkbox" checked={regionalGates} onChange={(e) => setRegionalGates(e.target.checked)} />
                {t('jumpPlanner.regionalGatesUse')}
              </span>
            </Labelled>
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
          {dockWarn.map((w) => (
            <div key={w.msg} style={{ color: w.bad ? 'var(--cv-conn-expired)' : 'var(--cv-conn-eol, #e69f00)', fontSize: 13 }}>⚠ {w.msg}</div>
          ))}

          {result?.route && (
            <div style={{ borderTop: '1px solid #30363d', paddingTop: 10 }}>
              <div style={{ fontSize: 14, marginBottom: 8 }}>
                {t('jumpPlanner.result', { jumps: result.route.jumps, ly: result.route.totalLy.toFixed(1), fuel: fuel.toLocaleString() })}
                {result.route.gates > 0 && (
                  <span style={{ color: 'var(--cv-conn-eol, #e69f00)' }}> · {t('jumpPlanner.viaGates', { gates: result.route.gates })}</span>
                )}
              </div>
              {fatigue && result.route.jumps > 0 && (
                <div title={t('jumpPlanner.fatigueHint')} style={{ fontSize: 13, marginBottom: 8, color: fatigue.hitCap ? 'var(--cv-conn-eol, #e69f00)' : 'var(--text-subtle)' }}>
                  {t('jumpPlanner.peakFatigue')}: <strong>{formatMinutes(fatigue.peakFatigueMin)}</strong>
                  {fatigue.hitCap && ` (${t('jumpPlanner.fatigueCapped')})`}
                  {' · '}{t('jumpPlanner.runTime')}: <strong>{formatMinutes(fatigue.totalCooldownMin)}</strong>
                </div>
              )}
              <RouteMap hops={result.route.hops} />
              <ol style={{ margin: '10px 0 0', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {result.route.hops.map((h, i) => (
                  <li key={h.eveSystemId} style={{ fontSize: 13 }}>
                    {h.name} <span style={{ color: 'var(--text-faint)' }}>{h.systemClass}</span>
                    {i > 0 && (h.viaGate
                      ? <span style={{ color: 'var(--cv-conn-eol, #e69f00)' }}> — {t('jumpPlanner.regionalGateHop')}</span>
                      : <span style={{ color: 'var(--text-subtle)' }}> — {h.lyFromPrev.toFixed(2)} ly</span>)}
                    {i > 0 && fatigue?.perHop[i] && (
                      <span style={{ color: 'var(--text-faint)' }}>
                        {' · '}
                        <span title={t('jumpPlanner.fatigueLabel')} style={{ color: '#56b4e9' }}>{formatMinutes(fatigue.perHop[i]!.fatigueMin)}</span>
                        {' / '}
                        <span title={t('jumpPlanner.cooldownLabel')} style={{ color: 'var(--cv-conn-eol, #e69f00)' }}>{formatMinutes(fatigue.perHop[i]!.cooldownMin)}</span>
                      </span>
                    )}
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
  const { t } = useTranslation();
  if (hops.length < 2) return null;
  const W = 820, H = 300, PAD = 34;
  const xs = hops.map((h) => h.x), ys = hops.map((h) => h.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
  const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const ox = (W - spanX * scale) / 2, oy = (H - spanY * scale) / 2;
  const sx = (x: number) => ox + (x - minX) * scale;
  // Flip Y: CCP's 2D projection grows northward, SVG grows downward — without
  // this the map renders upside-down (a northern destination appears south).
  const sy = (y: number) => oy + (maxY - y) * scale;
  const pts = hops.map((h) => ({ x: sx(h.x), y: sy(h.y), h }));
  const hasGate = hops.some((h) => h.viaGate);
  const dot = (color: string) => (
    <span style={{ display: 'inline-block', width: 11, height: 11, borderRadius: '50%', background: color, border: '2px solid #56b4e9', boxSizing: 'border-box' }} />
  );
  const legendItem = (color: string, label: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>{dot(color)} {label}</span>
  );
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 300, background: '#0d1117', borderRadius: 6, display: 'block' }}>
        {/* One line per leg so a regional-gate jump can render dashed/amber. */}
        {pts.slice(1).map((p, idx) => {
          const prev = pts[idx];
          return <line key={p.h.eveSystemId} x1={prev.x} y1={prev.y} x2={p.x} y2={p.y}
            stroke={p.h.viaGate ? '#e69f00' : '#56b4e9'} strokeWidth={2} opacity={0.85}
            strokeDasharray={p.h.viaGate ? '5 4' : undefined} />;
        })}
        {pts.map((p, i) => {
          const first = i === 0, last = i === pts.length - 1;
          return (
            <g key={p.h.eveSystemId}>
              <circle cx={p.x} cy={p.y} r={first || last ? 6 : 4}
                fill={first ? '#3ddc84' : last ? '#e69f00' : '#161b22'} stroke="#56b4e9" strokeWidth={2} />
              {(first || last || pts.length <= 12) && (
                // Alternate labels above/below along the path so clustered
                // systems don't overprint each other; a dark halo keeps them
                // readable over lines and adjacent labels.
                <text x={p.x} y={p.y + (i % 2 === 0 ? -9 : 18)} fill="#c9d1d9" fontSize={11} textAnchor="middle"
                  stroke="#0d1117" strokeWidth={3} paintOrder="stroke">{p.h.name}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div style={{ position: 'absolute', top: 8, right: 10, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-subtle)', background: 'rgba(13,17,23,0.7)', padding: '5px 8px', borderRadius: 5 }}>
        {legendItem('#3ddc84', t('jumpPlanner.legendOrigin'))}
        {pts.length > 2 && legendItem('#161b22', t('jumpPlanner.legendHop'))}
        {legendItem('#e69f00', t('jumpPlanner.legendDest'))}
        {hasGate && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ display: 'inline-block', width: 14, borderTop: '2px dashed #e69f00' }} /> {t('jumpPlanner.legendGate')}
          </span>
        )}
      </div>
    </div>
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

// LS/NS system search that adds picks to a list (avoidance / waypoints) rather
// than holding a single value. Reuses the shared search-results dropdown.
function AddSystemSearch({ onAdd, placeholder }: { onAdd: (s: { id: number; name: string }) => void; placeholder: string }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const { results, loading } = useEsiSearch(query);
  // Pochven (Triglavian) systems read LS/NS by security but can't be jumped
  // to/through, so they're never valid jump points — exclude them.
  const kspace = results.filter((r) => (r.systemClass === 'LS' || r.systemClass === 'NS') && r.npcType !== 'Triglavian');
  const show = query.trim().length >= 2 && (kspace.length > 0 || loading);
  return (
    <div style={{ position: 'relative' }}>
      <input className="chains-new__name" style={{ width: '100%' }} type="text" value={query}
        placeholder={placeholder} onChange={(e) => setQuery(e.target.value)} />
      {show && (
        <ul className="search-results">
          {loading && <li className="search-results__item" style={{ cursor: 'default', opacity: 0.6 }}>{t('jumpPlanner.searching')}</li>}
          {kspace.map((r) => (
            <li key={r.id} className="search-results__item" role="option"
              onMouseDown={(e) => { e.preventDefault(); onAdd({ id: r.id, name: r.name }); setQuery(''); }}>
              <span>{r.name}</span>
              <span className="search-results__class">{systemResultLabel(r)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const SKILL_LABELS = ['0', 'I', 'II', 'III', 'IV', 'V'];
function Skill({ value, onChange, readOnly, ariaLabel }: { value: number; onChange?: (n: number) => void; readOnly?: boolean; ariaLabel?: string }) {
  return (
    <Select value={String(value)} onChange={(v) => onChange?.(Number(v))} disabled={readOnly} ariaLabel={ariaLabel}
      options={[0, 1, 2, 3, 4, 5].map((l) => ({ value: String(l), label: SKILL_LABELS[l] }))} />
  );
}

// LS/NS system search field (label + input + dropdown), controlled by a picked
// value. Matching corp structures (in jumpable LS/NS systems) are offered above
// the system results; picking one resolves to its containing system.
function Field({ label, value, onPick, structures }: { label: string; value: Picked; onPick: (v: Picked) => void; structures: CorpStructure[] }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const { results, loading } = useEsiSearch(query);
  // Pochven (Triglavian) systems read LS/NS by security but can't be jumped
  // to/through, so they're never valid jump points — exclude them.
  const kspace = results.filter((r) => (r.systemClass === 'LS' || r.systemClass === 'NS') && r.npcType !== 'Triglavian');
  const q = query.trim().toLowerCase();
  const structMatches = q.length >= 2
    ? structures.filter((s) => s.solarSystemId != null && (s.systemClass === 'LS' || s.systemClass === 'NS') && s.name.toLowerCase().includes(q)).slice(0, 6)
    : [];
  // NPC stations in the matched LS/NS systems (one per system — all dock alike).
  const kspaceIds = kspace.map((r) => r.id).join(',');
  const [stationSys, setStationSys] = useState<{ solarSystemId: number; systemName: string }[]>([]);
  useEffect(() => {
    if (!kspaceIds) { setStationSys([]); return; }
    let off = false;
    api<{ solarSystemId: number; systemName: string }[]>(`/api/structures/stations?systems=${kspaceIds}`)
      .then((r) => { if (!off) setStationSys(r); }).catch(() => { if (!off) setStationSys([]); });
    return () => { off = true; };
  }, [kspaceIds]);
  const show = query.trim().length >= 2 && (structMatches.length > 0 || stationSys.length > 0 || kspace.length > 0 || loading);
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
          {structMatches.map((s) => (
            <li key={`st-${s.key}`} className="search-results__item" role="option"
              onMouseDown={(e) => { e.preventDefault(); onPick({ id: s.solarSystemId!, name: s.name, structureType: s.typeName || null }); setQuery(''); }}>
              <span>{s.name}</span>
              <span className="search-results__class">{s.typeName || t('jumpPlanner.structureFallback')} · {s.systemName}</span>
            </li>
          ))}
          {stationSys.map((s) => (
            <li key={`sta-${s.solarSystemId}`} className="search-results__item" role="option"
              onMouseDown={(e) => { e.preventDefault(); onPick({ id: s.solarSystemId, name: s.systemName, structureType: 'station' }); setQuery(''); }}>
              <span>{s.systemName}</span>
              <span className="search-results__class">{t('jumpPlanner.npcStation')}</span>
            </li>
          ))}
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
