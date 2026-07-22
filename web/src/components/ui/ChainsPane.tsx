import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, Modifier } from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, arrayMove, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMapStore } from '../../store/mapStore';
import { useCanEdit } from '../../hooks/useCanEdit';
import { useWormholeTypes } from '../../hooks/useWormholeTypes';
import { api } from '../../api/client';
import { toast } from './Toaster';
import { buildChainPath, buildChainSteps, reverseRoute } from '../../utils/chains';
import type { ChainStep } from '../../utils/chains';
import { whSizeForType, whSizeLabel } from '../../utils/wormholeSize';
import { SystemCombobox } from './SystemCombobox';
import type { Signature, SavedRoute } from '../../types';
import {
  CaretRightIcon, CaretDownIcon, TrashIcon, ArrowRightIcon,
  ArrowBendUpRightIcon, WarningIcon, ArrowsLeftRightIcon,
} from '@phosphor-icons/react';

// A chain row is dragged only up/down within the list; zero the X component so
// both the drag transform and collision detection lock to the vertical axis
// (same one-liner the Sidebar uses for its panel reorder).
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

// Recorded chains: pick a start + end system, the tool finds the shortest path
// through the map's own connections and saves it; expanding a chain shows the
// per-hop directions (warp to which sig / jump which gate), with any hop whose
// connection has gone flagged for re-scouting.
export function ChainsPane() {
  const { t } = useTranslation();
  const map               = useMapStore((s) => s.map);
  const addRoute          = useMapStore((s) => s.addRoute);
  const reorderRoutes     = useMapStore((s) => s.reorderRoutes);
  const canEdit           = useCanEdit();
  const whTypes           = useWormholeTypes();

  const sensors  = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const routeIds = useMemo(() => map.routes.map((r) => r.id), [map.routes]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = routeIds.indexOf(String(active.id));
    const to   = routeIds.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    reorderRoutes(arrayMove(routeIds, from, to));
  };

  const [fromId, setFromId] = useState('');
  const [toId, setToId]     = useState('');
  const [name, setName]     = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Chains the user is viewing reversed (client-only, never persisted): the
  // saved route stays as-is in the DB; this just flips the displayed direction.
  const [reversedIds, setReversedIds] = useState<Set<string>>(new Set());
  const toggleReversed = (id: string) => setReversedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // systemId -> its signatures, for the expanded chain's from-systems, so steps
  // can name the sig to warp to (explicit link or auto-matched by "leads to").
  const [sigsBySystem, setSigsBySystem] = useState<Map<string, Signature[]>>(new Map());

  const sortedSystems = useMemo(
    () => [...map.systems].sort((a, b) => a.name.localeCompare(b.name)),
    [map.systems],
  );
  const nameById = useMemo(
    () => new Map(map.systems.map((s) => [s.id, s.name])),
    [map.systems],
  );

  // Load the signatures for the expanded chain so its steps can name the sig to
  // warp to. We load EVERY system on the route (not just the forward from-
  // systems) so the reversed view has the near-side sigs for the return hops too.
  useEffect(() => {
    if (!expandedId || !map.id) return;
    const route = map.routes.find((r) => r.id === expandedId);
    if (!route) return;
    const fromSystems = Array.from(new Set(route.systemIds));
    let cancelled = false;
    Promise.all(
      fromSystems.map((sysId) =>
        api<Signature[]>(`/api/maps/${map.id}/systems/${sysId}/signatures`).catch(() => [] as Signature[]),
      ),
    ).then((lists) => {
      if (cancelled) return;
      const next = new Map<string, Signature[]>();
      fromSystems.forEach((sysId, i) => next.set(sysId, lists[i] ?? []));
      setSigsBySystem(next);
    });
    return () => { cancelled = true; };
  }, [expandedId, map.id, map.routes]);

  // Wormhole size derived from the SDE per-jump cap (shared helper).
  const sizeLabel = (whType: string | null): string | null => {
    const cls = whSizeForType(whType, whTypes);
    return cls ? whSizeLabel(t, cls) : null;
  };

  const create = () => {
    if (!fromId || !toId || fromId === toId) return;
    const path = buildChainPath(map, fromId, toId);
    if (!path) { toast.error(t('chains.noPath')); return; }
    const label = name.trim() ||
      `${nameById.get(fromId) ?? '?'} ${'→'} ${nameById.get(toId) ?? '?'}`;
    addRoute(label, path.systemIds, path.connectionIds);
    setName('');
    setFromId('');
    setToId('');
  };

  return (
    <div className="chains-pane">
      {canEdit && (
        <div className="chains-new">
          <SystemCombobox
            systems={sortedSystems}
            value={fromId}
            onChange={setFromId}
            placeholder={t('chains.from')}
            excludeId={toId}
          />
          <SystemCombobox
            systems={sortedSystems}
            value={toId}
            onChange={setToId}
            placeholder={t('chains.to')}
            excludeId={fromId}
          />
          <input
            className="chains-new__name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('chains.namePlaceholder')}
          />
          <button
            type="button"
            className="sys-btn"
            disabled={!fromId || !toId || fromId === toId}
            onClick={create}
          >
            {t('chains.create')}
          </button>
        </div>
      )}

      {map.routes.length === 0 ? (
        <div className="chains-empty">{t('chains.empty')}</div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={routeIds} strategy={verticalListSortingStrategy}>
            <ul className="chains-list">
              {map.routes.map((route) => {
                const open     = expandedId === route.id;
                const reversed = reversedIds.has(route.id);
                // The route as displayed: flipped when the user reversed it, so
                // steps, hop highlights and the sig lookup all use one direction.
                const view  = reversed ? reverseRoute(route) : route;
                const steps = open ? buildChainSteps(view, map, sigsBySystem) : [];
                return (
                  <SortableChainItem
                    key={route.id}
                    route={view}
                    open={open}
                    steps={steps}
                    canEdit={canEdit}
                    reversed={reversed}
                    draggable={canEdit && map.routes.length > 1}
                    onToggle={() => setExpandedId(open ? null : route.id)}
                    onReverse={() => toggleReversed(route.id)}
                    sizeLabel={sizeLabel}
                  />
                );
              })}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

interface SortableChainItemProps {
  route: SavedRoute;
  open: boolean;
  steps: ChainStep[];
  canEdit: boolean;
  reversed: boolean;
  draggable: boolean;
  onToggle: () => void;
  onReverse: () => void;
  sizeLabel: (whType: string | null) => string | null;
}

// One chain row: drag handle + collapsible header + per-hop steps. Pulls its
// own store actions so the parent only threads view state through props.
function SortableChainItem({ route, open, steps, canEdit, reversed, draggable, onToggle, onReverse, sizeLabel }: SortableChainItemProps) {
  const { t } = useTranslation();
  const removeRoute         = useMapStore((s) => s.removeRoute);
  const setRouteHighlight   = useMapStore((s) => s.setRouteHighlight);
  const requestCenterOnNode = useMapStore((s) => s.requestCenterOnNode);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: route.id, disabled: !draggable });
  const hops = route.connectionIds.length;

  return (
    <li
      ref={setNodeRef}
      className="chain-item"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        zIndex: isDragging ? 10 : undefined,
      }}
      // Highlight the whole chain on the map while hovered (suppressed mid-drag).
      onMouseEnter={() => { if (!isDragging) setRouteHighlight({ systemIds: route.systemIds, connectionIds: route.connectionIds }); }}
      onMouseLeave={() => setRouteHighlight(null)}
    >
      <div className="chain-item__head">
        {draggable && (
          <button
            type="button"
            className="chain-item__drag-handle"
            {...listeners}
            {...attributes}
            onClick={(e) => e.stopPropagation()}
            title={t('closest.dragToReorder')}
          >
            ⠿
          </button>
        )}
        <button
          type="button"
          className="chain-item__toggle"
          onClick={onToggle}
        >
          {open ? <CaretDownIcon size={12} weight="bold" /> : <CaretRightIcon size={12} weight="bold" />}
          <span className="chain-item__name">{route.name || t('chains.unnamed')}</span>
          <span className="chain-item__hops">{t('chains.hops', { count: hops })}</span>
        </button>
        {/* Reverse the DISPLAYED direction (client-only; the saved route is
            untouched) — so the return trip's sigs are read straight off one
            saved chain. Shown to everyone; reversing is a view action. */}
        <button
          type="button"
          className={`icon-btn chain-item__reverse${reversed ? ' chain-item__reverse--on' : ''}`}
          title={t('chains.reverse')}
          aria-pressed={reversed}
          onClick={onReverse}
        >
          <ArrowsLeftRightIcon size={13} weight="regular" />
        </button>
        {canEdit && (
          <button
            type="button"
            className="icon-btn chain-item__del"
            title={t('chains.remove')}
            // Clear the hover highlight first — deleting unmounts this row, so
            // its onMouseLeave never fires and the map would stay dimmed.
            onClick={() => { setRouteHighlight(null); removeRoute(route.id); }}
          >
            <TrashIcon size={13} weight="regular" />
          </button>
        )}
      </div>

      {open && (
        <ol className="chain-steps">
          {steps.map((step) => (
            <li
              key={step.index}
              className={`chain-step${step.broken ? ' chain-step--broken' : ''}`}
              // Narrow the map highlight to just this hop on hover;
              // back to the whole chain on leave (still in the row).
              onMouseEnter={() => setRouteHighlight({
                systemIds: [step.fromId, step.toId],
                connectionIds: [route.connectionIds[step.index - 1]],
              })}
              onMouseLeave={() => setRouteHighlight({
                systemIds: route.systemIds,
                connectionIds: route.connectionIds,
              })}
            >
              <button
                type="button"
                className="chain-step__systems"
                title={t('chains.centerOn', { system: step.fromName })}
                onClick={() => requestCenterOnNode(step.fromId)}
              >
                <span className="chain-step__from">{step.fromName}</span>
                <ArrowRightIcon size={11} weight="bold" />
                <span className="chain-step__to">{step.toName}</span>
              </button>
              <div className="chain-step__via">
                {step.broken ? (
                  <span className="chain-step__broken">
                    <WarningIcon size={11} weight="fill" /> {t('chains.brokenHop')}
                  </span>
                ) : step.kind === 'gate' ? (
                  <span className="chain-step__warp">
                    <ArrowBendUpRightIcon size={11} weight="bold" />
                    {t('chains.viaGate')}
                  </span>
                ) : step.kind === 'jumpgate' ? (
                  <span className="chain-step__warp">
                    <ArrowBendUpRightIcon size={11} weight="bold" />
                    {t('chains.viaJumpBridge')}
                  </span>
                ) : (
                  <span className="chain-step__warp">
                    <ArrowBendUpRightIcon size={11} weight="bold" />
                    {step.sigId
                      ? t('chains.warpSig', { sig: step.sigId })
                      : t('chains.warpWormhole')}
                  </span>
                )}
              </div>
              {step.kind === 'wormhole' && !step.broken && step.whType && (() => {
                const size = sizeLabel(step.whType);
                return (
                  <div className="chain-step__meta">
                    <span>{t('chains.whTypeLabel')}: {step.whType}</span>
                    {size && <span>{t('chains.whSizeLabel')}: {size}</span>}
                  </div>
                );
              })()}
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
