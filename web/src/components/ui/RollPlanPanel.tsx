import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from './Select';
import { XIcon } from '../../icons';
import { ROLLER_PRESETS, type RollerShip } from '../../utils/rolling';
import {
  planPasses, nextShipName, loadPlan, savePlan, type RollPlan, type PlanShip,
} from '../../utils/rollPlan';

// The pass plan under the rolling calculator: the fleet's ships, then the
// passes in order, each line cold (green) or hot (red), out or back, with the
// mass used after it and whether the hole can close on it. "Fly next" puts
// the first line's mass on the connection like any other pass. The plan
// itself stays with this pilot (rollPlan.ts).

const SHORT: Record<string, string> = { Battleship: 'BS', 'Battleship + Higgs': 'BS+H', HIC: 'HIC' };
const shortName = (name: string) => SHORT[name] ?? (name.length > 10 ? `${name.slice(0, 9)}.` : name);

let seq = 0;
const newId = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

interface Props {
  connId: string;
  totalMass: number;
  maxJumpMass: number;
  massUsed: number;
  roller: RollerShip;
  canEdit: boolean;
  /** Add (or with a negative, take back) mass on the connection. */
  addMass: (kg: number) => void;
  massShort: (kg: number) => string;
}

export function RollPlanPanel({ connId, totalMass, maxJumpMass, massUsed, roller, canEdit, addMass, massShort }: Props) {
  const { t } = useTranslation();
  const [plan, setPlanState] = useState<RollPlan>(() => loadPlan(connId));
  const [planConn, setPlanConn] = useState(connId);
  // Another connection selected: its own plan.
  if (planConn !== connId) {
    setPlanConn(connId);
    setPlanState(loadPlan(connId));
  }
  const setPlan = (next: RollPlan) => { setPlanState(next); savePlan(connId, next); };

  const passes = planPasses(totalMass, massUsed, plan);
  const next = passes.find((p) => !p.line.done);
  const lastDone = [...passes].reverse().find((p) => p.line.done);
  const strand = passes.find((p) => !p.line.done && p.strands);

  const shipChoices = [
    ...ROLLER_PRESETS.map((p) => ({ value: `preset:${p.name}`, label: `${p.name} (${massShort(p.coldKg)}/${massShort(p.hotKg)})` })),
    { value: 'roller', label: t('rollPlan.myRoller', { name: roller.name, cold: massShort(roller.coldKg), hot: massShort(roller.hotKg) }) },
  ];
  const addShip = (choice: string) => {
    const base: RollerShip | undefined = choice === 'roller'
      ? roller
      : ROLLER_PRESETS.find((p) => `preset:${p.name}` === choice);
    if (!base) return;
    const ship: PlanShip = {
      id: newId(), name: nextShipName(shortName(base.name), plan.ships), coldKg: base.coldKg, hotKg: base.hotKg,
    };
    setPlan({ ...plan, ships: [...plan.ships, ship] });
  };
  const removeShip = (id: string) =>
    setPlan({ ships: plan.ships.filter((s) => s.id !== id), lines: plan.lines.filter((l) => l.shipId !== id || l.done) });

  // A new line: bring home a ship that's out, else send out the first one.
  const addLine = () => {
    if (!plan.ships.length) return;
    const counts = new Map<string, number>();
    for (const l of plan.lines) counts.set(l.shipId, (counts.get(l.shipId) ?? 0) + 1);
    const outShip = plan.ships.find((s) => (counts.get(s.id) ?? 0) % 2 === 1);
    const shipId = (outShip ?? plan.ships[0]).id;
    setPlan({ ...plan, lines: [...plan.lines, { id: newId(), shipId, hot: false, done: false }] });
  };
  const patchLine = (id: string, patch: Partial<{ shipId: string; hot: boolean }>) =>
    setPlan({ ...plan, lines: plan.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
  const removeLine = (id: string) => setPlan({ ...plan, lines: plan.lines.filter((l) => l.id !== id) });

  const flyNext = () => {
    if (!next) return;
    addMass(next.kg);
    setPlan({ ...plan, lines: plan.lines.map((l) => (l.id === next.line.id ? { ...l, done: true } : l)) });
  };
  const unfly = () => {
    if (!lastDone) return;
    addMass(-lastDone.kg);
    setPlan({ ...plan, lines: plan.lines.map((l) => (l.id === lastDone.line.id ? { ...l, done: false } : l)) });
  };

  const shipOptions = plan.ships.map((s) => ({ value: s.id, label: s.name }));

  return (
    <details className="roll-other roll-plan" open={plan.lines.length > 0 || undefined}>
      <summary>{t('rollPlan.title')}{plan.lines.length ? ` (${plan.lines.length})` : ''}</summary>

      <div className="roll-plan__ships">
        {plan.ships.map((s) => (
          <span key={s.id} className="roll-plan__ship">
            {s.name} <span className="roll-plan__muted">{massShort(s.coldKg)}/{massShort(s.hotKg)}</span>
            <button type="button" className="roll-plan__x" aria-label={t('rollPlan.removeShip', { name: s.name })}
              onClick={() => removeShip(s.id)}><XIcon size={10} /></button>
          </span>
        ))}
        <Select value="" placeholder={t('rollPlan.addShip')} options={shipChoices} onChange={addShip}
          ariaLabel={t('rollPlan.addShip')} showCheck={false} />
      </div>

      {passes.length > 0 && (
        <ol className="roll-plan__lines">
          {passes.map((p, i) => {
            const tooHeavy = p.kg > maxJumpMass;
            return (
              <li key={p.line.id} className={`roll-plan__line${p.line.done ? ' roll-plan__line--done' : ''}`}>
                <span className="roll-plan__n">{i + 1}</span>
                {p.line.done
                  ? <span className="roll-plan__shipname">{p.ship?.name}</span>
                  : <Select value={p.line.shipId} options={shipOptions} onChange={(v) => patchLine(p.line.id, { shipId: v })}
                      ariaLabel={t('rollPlan.ship')} />}
                <button
                  type="button"
                  className={`roll-plan__heat roll-plan__heat--${p.line.hot ? 'hot' : 'cold'}`}
                  disabled={p.line.done}
                  title={t('rollPlan.toggleHeat')}
                  onClick={() => patchLine(p.line.id, { hot: !p.line.hot })}
                >
                  {p.line.hot ? t('connPanel.hot') : t('connPanel.cold')} {massShort(p.kg)}
                </button>
                <span className="roll-plan__dir">{p.out ? t('rollPlan.out') : t('rollPlan.back')}</span>
                {p.line.done ? (
                  <span className="roll-plan__muted">{t('rollPlan.flown')}</span>
                ) : (
                  <span
                    className={`roll-plan__after roll-plan__after--${tooHeavy ? 'collapse' : p.outcome ?? 'safe'}`}
                    title={tooHeavy ? t('rollPlan.tooHeavy', { max: massShort(maxJumpMass) }) : t(`rollPlan.outcome.${p.outcome ?? 'safe'}`)}
                  >
                    {massShort(p.usedAfter ?? 0)}
                  </span>
                )}
                {!p.line.done && (
                  <button type="button" className="roll-plan__x" aria-label={t('rollPlan.removePass')}
                    onClick={() => removeLine(p.line.id)}><XIcon size={10} /></button>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {strand && (
        <div className="roll-guidance roll-guidance--danger">
          {t('rollPlan.strands', { n: passes.indexOf(strand) + 1, ship: strand.ship?.name ?? '' })}
        </div>
      )}

      <div className="roll-actions">
        <button type="button" className="sys-btn" disabled={!plan.ships.length} onClick={addLine}>
          {t('rollPlan.addPass')}
        </button>
        <button type="button" className="sys-btn" disabled={!canEdit || !next} onClick={flyNext}
          title={next ? t('rollPlan.flyNextTitle', { ship: next.ship?.name ?? '', mass: massShort(next.kg) }) : undefined}>
          {t('rollPlan.flyNext')}
        </button>
        <button type="button" className="sys-btn" disabled={!canEdit || !lastDone} onClick={unfly}>
          {t('rollPlan.undoFlown')}
        </button>
        <button type="button" className="sys-btn mass-tracker__reset" disabled={!plan.ships.length && !plan.lines.length}
          onClick={() => setPlan({ ships: [], lines: [] })}>
          {t('rollPlan.clear')}
        </button>
      </div>
    </details>
  );
}
