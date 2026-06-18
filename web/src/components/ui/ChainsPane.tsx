import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMapStore } from '../../store/mapStore';
import { useCanEdit } from '../../hooks/useCanEdit';
import { api } from '../../api/client';
import { toast } from './Toaster';
import { buildChainPath, buildChainSteps } from '../../utils/chains';
import { SystemCombobox } from './SystemCombobox';
import type { Signature } from '../../types';
import {
  CaretRightIcon, CaretDownIcon, TrashIcon, ArrowRightIcon,
  ArrowBendUpRightIcon, WarningIcon,
} from '@phosphor-icons/react';

// Recorded chains: pick a start + end system, the tool finds the shortest path
// through the map's own connections and saves it; expanding a chain shows the
// per-hop directions (warp to which sig / jump which gate), with any hop whose
// connection has gone flagged for re-scouting.
export function ChainsPane() {
  const { t } = useTranslation();
  const map               = useMapStore((s) => s.map);
  const addRoute          = useMapStore((s) => s.addRoute);
  const removeRoute       = useMapStore((s) => s.removeRoute);
  const requestCenterOnNode = useMapStore((s) => s.requestCenterOnNode);
  const canEdit           = useCanEdit();

  const [fromId, setFromId] = useState('');
  const [toId, setToId]     = useState('');
  const [name, setName]     = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // uuid -> Signature for the expanded chain's endpoint systems, so steps can
  // show the exact sig code you warp to.
  const [sigsById, setSigsById] = useState<Map<string, Signature>>(new Map());

  const sortedSystems = useMemo(
    () => [...map.systems].sort((a, b) => a.name.localeCompare(b.name)),
    [map.systems],
  );
  const nameById = useMemo(
    () => new Map(map.systems.map((s) => [s.id, s.name])),
    [map.systems],
  );

  // Load the endpoint signatures for the expanded chain so its steps can name
  // the sig to warp to. Only the "from" system of each hop matters.
  useEffect(() => {
    if (!expandedId || !map.id) return;
    const route = map.routes.find((r) => r.id === expandedId);
    if (!route) return;
    const fromSystems = Array.from(new Set(route.systemIds.slice(0, -1)));
    let cancelled = false;
    Promise.all(
      fromSystems.map((sysId) =>
        api<Signature[]>(`/api/maps/${map.id}/systems/${sysId}/signatures`).catch(() => [] as Signature[]),
      ),
    ).then((lists) => {
      if (cancelled) return;
      const next = new Map<string, Signature>();
      for (const list of lists) for (const sig of list) next.set(sig.id, sig);
      setSigsById(next);
    });
    return () => { cancelled = true; };
  }, [expandedId, map.id, map.routes]);

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
        <ul className="chains-list">
          {map.routes.map((route) => {
            const open  = expandedId === route.id;
            const hops  = route.connectionIds.length;
            const steps = open ? buildChainSteps(route, map, sigsById) : [];
            return (
              <li key={route.id} className="chain-item">
                <div className="chain-item__head">
                  <button
                    type="button"
                    className="chain-item__toggle"
                    onClick={() => setExpandedId(open ? null : route.id)}
                  >
                    {open ? <CaretDownIcon size={12} weight="bold" /> : <CaretRightIcon size={12} weight="bold" />}
                    <span className="chain-item__name">{route.name || t('chains.unnamed')}</span>
                    <span className="chain-item__hops">{t('chains.hops', { count: hops })}</span>
                  </button>
                  {canEdit && (
                    <button
                      type="button"
                      className="icon-btn chain-item__del"
                      title={t('chains.remove')}
                      onClick={() => removeRoute(route.id)}
                    >
                      <TrashIcon size={13} weight="regular" />
                    </button>
                  )}
                </div>

                {open && (
                  <ol className="chain-steps">
                    {steps.map((step) => (
                      <li key={step.index} className={`chain-step${step.broken ? ' chain-step--broken' : ''}`}>
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
                              {step.whType ? <span className="chain-step__wh">{step.whType}</span> : null}
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
