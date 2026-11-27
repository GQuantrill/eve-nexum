import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, Modifier } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GearIcon, MapPinSimpleIcon, PathIcon, PlusIcon, MinusIcon } from '../../icons';
import { api } from '../../api/client';
import { useRouteOptions, type RoutePathNode, type RouteEntry } from '../../hooks/useRoute';
import { useRouteOrigin } from '../../hooks/useRouteOrigin';
import { useA0Systems } from '../../hooks/useA0Systems';
import { useClones } from '../../hooks/useClones';
import { useScoutConnections } from '../../hooks/useScoutConnections';
import { useIncursions } from '../../hooks/useIncursions';
import { useCurrentHourKills } from '../../hooks/useCurrentHourKills';
import { useUserSetting } from '../../hooks/useUserSetting';
import { useSystemAlias } from '../../hooks/useSystemAlias';
import { useMapStore } from '../../store/mapStore';
import { truesecColor } from '../../utils/truesec';
import { setWaypoint, canSetAutopilot } from '../../utils/routeActions';
import { LIST_KEY, HIDDEN_HOME_KEY, ALL_MAPS_KEY, HUB_DEFAULTS, sanitiseList, type StoredEntry } from '../../utils/closestList';
import { structureKind, STRUCTURE_KINDS, type StructureKind } from '../../utils/structureKind';
import { jumps as jumpsLabel } from '../../i18n/format';
import { Select } from './Select';
import { RouteSquares, RouteOriginNote } from './routeUi';
import { PanelVisibilityModal } from './PanelVisibilityModal';
import styles from './UsefulSystemsPane.module.css';

// Useful Systems: the nearest few of each useful kind of system (hubs,
// security bands, stations and their services, blue loot buyers, clones, corp
// structures, Thera/Turnur entrances...), in groups the user can fold, reorder
// and hide. The server finds every open group in one request
// (POST /api/route/nearest), routing from the same start as Closest Systems.

type Group =
  | 'hub' | 'hub2' | 'blueloot' | 'a0' | 'highsec' | 'lowsec' | 'nullsec' | 'station'
  | 'service' | 'concord' | 'clone' | 'structure' | 'thera' | 'turnur' | 'incursion' | 'quiet';

const GROUPS: Group[] = [
  'hub', 'hub2', 'blueloot', 'a0', 'highsec', 'lowsec', 'nullsec', 'station',
  'service', 'concord', 'clone', 'structure', 'thera', 'turnur', 'incursion', 'quiet',
];
const VALID = new Set<string>(GROUPS);

// A clone bay is also where jump clones are made, so there's no separate
// "jump clone facility" choice; a saved one falls back to the clone bay.
type Service = 'cloning' | 'repair' | 'fitting' | 'market' | 'reprocessing' | 'insurance';
const SERVICES: Service[] = ['cloning', 'repair', 'fitting', 'market', 'reprocessing', 'insurance'];

const ORDER_KEY     = 'nexum.useful.order';
const COLLAPSED_KEY = 'nexum.useful.collapsed';
// What's HIDDEN, not shown, so a group added later shows up. Quiet systems
// starts hidden: it's the most niche, and the slowest to work out.
const HIDDEN_KEY    = 'nexum.useful.hidden';
const SERVICE_KEY   = 'nexum.closestSystems.suggestService';
const STRUCT_KEY    = 'nexum.useful.structureKind';

/** Blue loot type ids, short names as players say them (EVE item names). */
const BLUE_LOOT: Record<number, string> = {
  30744: 'Neural Network Analyzer',
  30745: 'Sleeper Data Library',
  30746: 'Ancient Coordinates Database',
  30747: 'Sleeper Drone AI Nexus',
};

const LIMIT = 3;

interface Found extends RouteEntry {
  id:      number;
  path:    RoutePathNode[];
  detail?: number[];
}

interface CorpStructure { name: string; typeName: string; solarSystemId: number | null; source: 'corp' | 'map' }

const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** A stored list of groups, cleaned: known ids only, no repeats. */
function cleanGroups(raw: unknown): Group[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((g): g is Group => typeof g === 'string' && VALID.has(g)))];
}

/** The saved order, with any group it doesn't know yet added at the end. */
function sanitiseOrder(raw: unknown): Group[] {
  const known = cleanGroups(raw);
  return [...known, ...GROUPS.filter((g) => !known.includes(g))];
}

export function UsefulSystemsPane() {
  const { t } = useTranslation();
  const aliasName = useSystemAlias();
  const routeMode = useMapStore((s) => s.routeMode);
  // Routed the same way as Closest Systems: its "all maps" choice applies here too.
  const [allMaps] = useUserSetting<boolean>(ALL_MAPS_KEY, true);
  const whScope = allMaps ? 'all' : 'active';
  const origin = useRouteOrigin(whScope);
  const { body: routeBody, revision } = useRouteOptions(whScope);

  const [orderRaw, setOrder]         = useUserSetting<Group[]>(ORDER_KEY, GROUPS);
  const [collapsedRaw, setCollapsed] = useUserSetting<Group[]>(COLLAPSED_KEY, []);
  const [hiddenRaw, setHidden]       = useUserSetting<Group[]>(HIDDEN_KEY, ['quiet']);
  const order     = useMemo(() => sanitiseOrder(orderRaw), [orderRaw]);
  const collapsed = useMemo(() => new Set(cleanGroups(collapsedRaw)), [collapsedRaw]);
  const hidden    = useMemo(() => new Set(cleanGroups(hiddenRaw)), [hiddenRaw]);
  const shown     = order.filter((g) => !hidden.has(g));
  const [choosing, setChoosing] = useState(false);

  const [service, setService] = useUserSetting<Service>(SERVICE_KEY, 'cloning');
  const shownService: Service = SERVICES.includes(service) ? service : 'cloning';
  const [structKindRaw, setStructKind] = useUserSetting<StructureKind>(STRUCT_KEY, 'all');
  const structKind: StructureKind = STRUCTURE_KINDS.includes(structKindRaw) ? structKindRaw : 'all';

  // The Closest Systems list, which each row can add to.
  const [listRaw, setList] = useUserSetting<StoredEntry[]>(LIST_KEY, HUB_DEFAULTS);
  const [, setHiddenHome]  = useUserSetting<number[]>(HIDDEN_HOME_KEY, []);
  const onList = useMemo(() => new Set(sanitiseList(listRaw).map((e) => e.id)), [listRaw]);
  const toggleOnList = (id: number, name: string) => {
    if (onList.has(id)) {
      setList((prev) => sanitiseList(prev).filter((e) => e.id !== id));
    } else {
      setList((prev) => [...sanitiseList(prev), { id, name }]);
      setHiddenHome((prev) => (Array.isArray(prev) ? prev.filter((x) => x !== id) : []));
    }
  };

  // The sets the browser already has.
  const a0 = useA0Systems();
  const clones = useClones();
  const jumpClones = clones.jumpClones;
  const scout = useScoutConnections();
  const incursions = useIncursions();
  const kills = useCurrentHourKills();
  // Corp structures, read once: they change rarely, and a big corp's list is long.
  const [structures, setStructures] = useState<CorpStructure[]>([]);
  useEffect(() => {
    let cancelled = false;
    api<CorpStructure[]>('/api/structures')
      .then((rows) => { if (!cancelled) setStructures(rows.filter((s) => s.source === 'corp' && s.solarSystemId != null)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  // Structure names per system, of the chosen kind: the candidates, and what a row names.
  const structuresBySystem = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const s of structures) {
      if (!structureKind(s.typeName, structKind)) continue;
      const id = s.solarSystemId as number;
      const list = m.get(id);
      if (list) list.push(s.name); else m.set(id, [s.name]);
    }
    return m;
  }, [structures, structKind]);

  // One request for every open group. Folded and hidden ones aren't asked for.
  const wantedKey = shown.filter((g) => !collapsed.has(g)).join(',');
  // Plain, not memoised: it only feeds requestKey, a string.
  const sets = (() => {
    const wanted = wantedKey ? (wantedKey.split(',') as Group[]) : [];
    const ids = (xs: Iterable<number>) => [...new Set(xs)].sort((a, b) => a - b);
    const hub = (name: string) => ids(scout.filter((c) => !c.expired && c.outSystemName === name).map((c) => c.inSystemId));
    const spec = (g: Group): unknown => {
      switch (g) {
        case 'a0':        return ids(a0.map((x) => x.id));
        case 'clone':     return ids(jumpClones.flatMap((c) => (c.system ? [c.system.eveSystemId] : [])));
        case 'structure': return ids(structuresBySystem.keys());
        case 'thera':     return hub('Thera');
        case 'turnur':    return hub('Turnur');
        case 'incursion': return ids(incursions.map((i) => i.systemId));
        case 'service':   return `service:${shownService}`;
        case 'quiet':     return { kind: 'kspace', exclude: ids([...kills.values()].filter((k) => k.shipKills + k.podKills > 0).map((k) => k.systemId)) };
        default:          return g;
      }
    };
    return Object.fromEntries(wanted.map((g) => [g, spec(g)]));
  })();

  const from = origin.systemId;
  const requestKey = JSON.stringify({ from, sets, routeBody, revision });
  const [result, setResult] = useState<{ key: string; data: Record<string, Found[]> } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (from === null || !wantedKey) return;
    let cancelled = false;
    // The client sets fill in over the first moments (clones, scout, kills),
    // so wait for them to settle rather than asking several times.
    const timer = setTimeout(() => {
      const { sets: s, routeBody: b } = JSON.parse(requestKey) as { sets: unknown; routeBody: object };
      api<Record<string, Found[]>>('/api/route/nearest', {
        method: 'POST',
        body: JSON.stringify({ ...b, from, limit: LIMIT, sets: s }),
      })
        .then((data) => { if (!cancelled) { setResult({ key: requestKey, data }); setFailed(null); } })
        .catch(() => { if (!cancelled) setFailed(requestKey); });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [requestKey, from, wantedKey]);
  // Rows from the latest answer stay up while a newer one is worked out.
  const pending = result?.key !== requestKey && failed !== requestKey;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const a = order.indexOf(active.id as Group), b = order.indexOf(over.id as Group);
    if (a !== -1 && b !== -1) setOrder(arrayMove(order, a, b));
  };
  const toggleCollapsed = (g: Group) =>
    setCollapsed((prev) => { const l = cleanGroups(prev); return l.includes(g) ? l.filter((x) => x !== g) : [...l, g]; });
  const toggleHidden = (g: Group) =>
    setHidden((prev) => { const l = cleanGroups(prev); return l.includes(g) ? l.filter((x) => x !== g) : [...l, g]; });

  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  if (from === null) {
    return (
      <div className="scout-pane">
        <RouteOriginNote origin={origin} />
        <div className="scout-pane__empty">{t(origin.blocked === 'wormholeOptionOff' ? 'closest.inWormhole' : origin.blocked === 'notOnMap' ? 'closest.notOnMap' : 'closest.signIn')}</div>
      </div>
    );
  }

  const title = (g: Group) => t(`closest.suggest.sections.${g}`);

  // The filter: a group whose name matches shows whole (the station services
  // and structure kinds count as its name, so "repair" finds stations with
  // one); otherwise only its rows whose system, alias or structure matches.
  const q = query.trim().toLowerCase();
  const hit = (text: string) => text.toLowerCase().includes(q);
  const groupWords = (g: Group): string[] => [
    title(g),
    ...(g === 'service' ? SERVICES.map((sv) => t(`closest.suggest.services.${sv}`)) : []),
    ...(g === 'structure' ? STRUCTURE_KINDS.map((k) => t(`useful.structureKinds.${k}`)) : []),
  ];
  const rowHit = (g: Group, r: Found) => {
    const name = r.path[r.path.length - 1]?.name ?? '';
    return hit(name) || hit(aliasName(name))
      || (g === 'structure' && (structuresBySystem.get(r.id) ?? []).some(hit));
  };
  const listed = shown.flatMap((g) => {
    const rows = result?.data[g];
    if (!q || groupWords(g).some(hit)) return [{ g, rows }];
    const matching = (rows ?? []).filter((r) => rowHit(g, r));
    return matching.length > 0 ? [{ g, rows: matching }] : [];
  });

  return (
    <div className={`scout-pane ${styles.pane}`}>
      <RouteOriginNote origin={origin} />
      <div className={styles.toolbar}>
        <input
          className={`chains-new__name ${styles.filter}`}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('useful.filter')}
          aria-label={t('useful.filter')}
          data-tooltip={t('useful.hint')}
          spellCheck={false}
        />
        <button
          type="button"
          className="icon-btn"
          onClick={() => setChoosing(true)}
          aria-label={t('useful.chooseGroups')}
          data-tooltip={t('useful.chooseGroups')}
        >
          <GearIcon size={14} weight="bold" />
        </button>
      </div>
      {failed === requestKey && <p className={styles.empty}>{t('closest.suggest.failed')}</p>}
      {shown.length === 0 && <p className={styles.empty}>{t('useful.allHidden')}</p>}
      {shown.length > 0 && listed.length === 0 && <p className={styles.empty}>{t('useful.noMatch')}</p>}

      <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={onDragEnd}>
        <SortableContext items={listed.map((l) => l.g)} strategy={verticalListSortingStrategy}>
          {listed.map(({ g, rows }) => {
            const isCollapsed = collapsed.has(g);
            return (
              <GroupSection
                key={g}
                id={g}
                title={title(g)}
                collapsed={isCollapsed}
                onToggle={() => toggleCollapsed(g)}
                control={g === 'service' ? (
                  <Select id="useful-service" value={shownService} onChange={(v) => setService(v as Service)}
                    options={SERVICES.map((sv) => ({ value: sv, label: t(`closest.suggest.services.${sv}`) }))} />
                ) : g === 'structure' ? (
                  <Select id="useful-structure" value={structKind} onChange={(v) => setStructKind(v as StructureKind)}
                    options={STRUCTURE_KINDS.map((k) => ({ value: k, label: t(`useful.structureKinds.${k}`) }))} />
                ) : null}
              >
                {g === 'quiet' && <p className={styles.note}>{t('closest.suggest.quietHint')}</p>}
                {g === 'concord' && <p className={styles.note}>{t('closest.suggest.concordHint')}</p>}
                {!rows || rows.length === 0 ? (
                  <p className={styles.empty}>
                    {pending ? t('closest.suggest.loading')
                      : t(emptyKey(g, clones.enabled, structures.length > 0, structuresBySystem.size > 0))}
                  </p>
                ) : rows.map((r) => {
                  const end = r.path[r.path.length - 1];
                  const name = end?.name ?? String(r.id);
                  const rowKey = `${g}:${r.id}`;
                  const isOpen = open === rowKey;
                  const autopilot = canSetAutopilot(r);
                  const here = g === 'structure' ? structuresBySystem.get(r.id) ?? [] : [];
                  return (
                    <div key={r.id} className="scout-row">
                      <div className="scout-row__sys">
                        <span className="scout-row__name">{aliasName(name)}</span>
                        {end && end.kspace && (
                          <span className={styles.sec} style={{ color: truesecColor(end.security) }}>
                            {end.security.toFixed(1)}
                          </span>
                        )}
                      </div>
                      {here.length > 0 && (
                        <div className={styles.detail}>
                          {here[0]}{here.length > 1 && ` ${t('useful.moreHere', { count: here.length - 1 })}`}
                        </div>
                      )}
                      {/* Every buyer seen so far takes all four, so only say so when one doesn't. */}
                      {r.detail && r.detail.length > 0 && r.detail.length < Object.keys(BLUE_LOOT).length && (
                        <div className={styles.detail}>{r.detail.map((id) => BLUE_LOOT[id] ?? id).join(', ')}</div>
                      )}
                      <div className="scout-row__actions">
                        <span className="scout-row__jumps">{jumpsLabel(t, r.jumps)}</span>
                        <button type="button" className="sys-btn scout-row__btn scout-row__btn--icon"
                          onClick={() => setWaypoint(r.id, name, true)} disabled={!autopilot}
                          aria-label={t('waypoint.setDestination')}
                          data-tooltip={autopilot ? t('waypoint.setDestination') : t('route.jspaceNoWaypoint')}>
                          <MapPinSimpleIcon size={14} weight="regular" color="#3ddc84" />
                        </button>
                        <button type="button" className="sys-btn scout-row__btn scout-row__btn--icon"
                          onClick={() => setWaypoint(r.id, name, false)} disabled={!autopilot}
                          aria-label={t('waypoint.addWaypoint')}
                          data-tooltip={autopilot ? t('waypoint.addWaypoint') : t('route.jspaceNoWaypoint')}>
                          <PathIcon size={14} weight="regular" color="#5a9af8" />
                        </button>
                        <button type="button" className="sys-btn scout-row__btn scout-row__btn--icon"
                          onClick={() => toggleOnList(r.id, name)}
                          aria-label={onList.has(r.id) ? t('useful.removeFromClosest') : t('useful.addToClosest')}
                          data-tooltip={onList.has(r.id) ? t('useful.removeFromClosest') : t('useful.addToClosest')}>
                          {onList.has(r.id) ? <MinusIcon size={12} weight="bold" /> : <PlusIcon size={12} weight="bold" />}
                        </button>
                        <button type="button" className="sys-btn scout-row__btn"
                          onClick={() => setOpen(isOpen ? null : rowKey)} aria-expanded={isOpen}>
                          {(() => {
                            const mode = routeMode === 'secure' ? t('a0.modeSecure') : t('a0.modeShortest');
                            return isOpen ? t('a0.hideRoute', { mode }) : t('a0.showRoute', { mode });
                          })()}
                        </button>
                      </div>
                      {isOpen && <RouteSquares route={r} />}
                    </div>
                  );
                })}
              </GroupSection>
            );
          })}
        </SortableContext>
      </DndContext>

      {choosing && (
        <PanelVisibilityModal
          title={t('useful.chooseGroups')}
          hint={t('useful.chooseGroupsHint')}
          panels={order.map((g) => ({ id: g, title: title(g) }))}
          isVisible={(g) => !hidden.has(g)}
          onToggle={toggleHidden}
          onClose={() => setChoosing(false)}
        />
      )}
    </div>
  );
}

/** One group: a header that folds it and drags it, and its rows. */
function GroupSection({ id, title, collapsed, onToggle, control, children }: {
  id: Group; title: string; collapsed: boolean; onToggle: () => void;
  control: React.ReactNode; children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <section
      ref={setNodeRef}
      className={styles.group}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1, zIndex: isDragging ? 10 : undefined }}
    >
      <div className={styles.head}>
        <button type="button" className={styles.fold} onClick={onToggle} aria-expanded={!collapsed}>
          <span className={`${styles.chevron}${collapsed ? ` ${styles.chevronCollapsed}` : ''}`}>▾</span>
          <span className={styles.title}>{title}</span>
        </button>
        {!collapsed && control}
        <button type="button" className={styles.drag} {...listeners} {...attributes}
          title={t('closest.dragToReorder')} aria-label={t('closest.dragToReorder')}>
          ⠿
        </button>
      </div>
      {!collapsed && !isDragging && <div className={styles.rows}>{children}</div>}
    </section>
  );
}

/** Why a group is empty, for a message that helps. */
type EmptyKey =
  | 'closest.suggest.none.clone' | 'closest.suggest.none.clonesOff' | 'closest.suggest.none.blueloot'
  | 'closest.suggest.none.scout' | 'closest.suggest.none.structure' | 'closest.suggest.none.incursion'
  | 'closest.suggest.none.generic' | 'useful.noStructureKind';

function emptyKey(g: Group, clonesEnabled: boolean, hasStructures: boolean, hasOfKind: boolean): EmptyKey {
  if (g === 'clone') return clonesEnabled ? 'closest.suggest.none.clone' : 'closest.suggest.none.clonesOff';
  if (g === 'blueloot') return 'closest.suggest.none.blueloot';
  if (g === 'thera' || g === 'turnur') return 'closest.suggest.none.scout';
  if (g === 'structure') {
    if (!hasStructures) return 'closest.suggest.none.structure';
    if (!hasOfKind) return 'useful.noStructureKind';
  }
  if (g === 'incursion') return 'closest.suggest.none.incursion';
  return 'closest.suggest.none.generic';
}
