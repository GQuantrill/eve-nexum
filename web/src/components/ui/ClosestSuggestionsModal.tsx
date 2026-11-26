import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon, PlusIcon, MinusIcon } from '../../icons';
import { api } from '../../api/client';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { useRouteOptions, type RoutePathNode } from '../../hooks/useRoute';
import { useA0Systems } from '../../hooks/useA0Systems';
import { useClones } from '../../hooks/useClones';
import { useScoutConnections } from '../../hooks/useScoutConnections';
import { useIncursions } from '../../hooks/useIncursions';
import { useCurrentHourKills } from '../../hooks/useCurrentHourKills';
import { useUserSetting } from '../../hooks/useUserSetting';
import { useSystemAlias } from '../../hooks/useSystemAlias';
import { truesecColor } from '../../utils/truesec';
import { jumps as jumpsLabel } from '../../i18n/format';
import { Select } from './Select';
import styles from './ClosestSuggestionsModal.module.css';

// Closest Systems > Suggestions: the nearest few of each useful kind of system
// (hubs, security bands, stations and their services, blue loot buyers, your
// clones, Thera/Turnur entrances...), each with Add to put it in the list. The
// server finds them all in one request (POST /api/route/nearest), routing the
// same way the pane does.

type Section =
  | 'hub' | 'hub2' | 'blueloot' | 'a0' | 'highsec' | 'lowsec' | 'nullsec' | 'station'
  | 'service' | 'concord' | 'clone' | 'thera' | 'turnur' | 'incursion' | 'structure' | 'quiet';

const SECTIONS: Section[] = [
  'hub', 'hub2', 'blueloot', 'a0', 'highsec', 'lowsec', 'nullsec', 'station',
  'service', 'concord', 'clone', 'thera', 'turnur', 'incursion', 'structure', 'quiet',
];

type Service = 'cloning' | 'jumpClone' | 'repair' | 'fitting' | 'market' | 'reprocessing' | 'insurance';
const SERVICES: Service[] = ['cloning', 'jumpClone', 'repair', 'fitting', 'market', 'reprocessing', 'insurance'];
const SERVICE_KEY = 'nexum.closestSystems.suggestService';

/** Blue loot type ids, short names as players say them (EVE item names). */
const BLUE_LOOT: Record<number, string> = {
  30744: 'Neural Network Analyzer',
  30745: 'Sleeper Data Library',
  30746: 'Ancient Coordinates Database',
  30747: 'Sleeper Drone AI Nexus',
};

interface Found {
  id:          number;
  jumps:       number;
  path:        RoutePathNode[];
  usesSpecial: boolean;
  detail?:     number[];
}

interface CorpStructure { solarSystemId: number | null; source: 'corp' | 'map' }

const LIMIT = 3;

export function ClosestSuggestionsModal({
  from, whScope, onList, onAdd, onRemove, onClose,
}: {
  from:    number;
  whScope: 'active' | 'all';
  onList:  ReadonlySet<number>;
  onAdd:    (id: number, name: string) => void;
  onRemove: (id: number) => void;
  onClose: () => void;
}) {
  useEscapeClose(onClose);
  const { t } = useTranslation();
  const aliasName = useSystemAlias();
  const { body: routeBody, revision } = useRouteOptions(whScope);
  const [service, setService] = useUserSetting<Service>(SERVICE_KEY, 'cloning');
  const shownService: Service = SERVICES.includes(service) ? service : 'cloning';

  // The sets the browser already has.
  const a0 = useA0Systems();
  const clones = useClones();
  const scout = useScoutConnections();
  const incursions = useIncursions();
  const kills = useCurrentHourKills();
  const [structures, setStructures] = useState<number[]>([]);
  useEffect(() => {
    let cancelled = false;
    api<CorpStructure[]>('/api/structures')
      .then((rows) => {
        if (cancelled) return;
        setStructures([...new Set(rows.filter((s) => s.source === 'corp' && s.solarSystemId != null)
          .map((s) => s.solarSystemId as number))]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const sets = useMemo(() => {
    const ids = (xs: Iterable<number>) => [...new Set(xs)].sort((a, b) => a - b);
    const hub = (name: string) => ids(scout.filter((c) => !c.expired && c.outSystemName === name).map((c) => c.inSystemId));
    const s: Record<string, unknown> = {
      hub: 'hub', hub2: 'hub2', blueloot: 'blueloot',
      highsec: 'highsec', lowsec: 'lowsec', nullsec: 'nullsec',
      station: 'station', concord: 'concord',
      a0: ids(a0.map((x) => x.id)),
      clone: ids(clones.jumpClones.flatMap((c) => (c.system ? [c.system.eveSystemId] : []))),
      thera: hub('Thera'),
      turnur: hub('Turnur'),
      incursion: ids(incursions.map((i) => i.systemId)),
      structure: structures,
      quiet: { kind: 'kspace', exclude: ids([...kills.values()].filter((k) => k.shipKills + k.podKills > 0).map((k) => k.systemId)) },
    };
    for (const sv of SERVICES) s[`service:${sv}`] = `service:${sv}`;
    return s;
  }, [a0, clones, scout, incursions, kills, structures]);

  const requestKey = JSON.stringify({ from, sets, routeBody, revision });
  const [result, setResult] = useState<{ key: string; data: Record<string, Found[]> } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // The client sets fill in over the first moments (clones, scout, kills),
    // so wait for them to settle rather than asking several times.
    const timer = setTimeout(() => {
      const { sets: s, routeBody: b } = JSON.parse(requestKey) as { sets: unknown; routeBody: object };
      api<Record<string, Found[]>>('/api/route/nearest', {
        method: 'POST',
        body: JSON.stringify({ ...b, from, limit: LIMIT, sets: s }),
      })
        .then((data) => { if (!cancelled) { setResult({ key: requestKey, data }); setFailed(false); } })
        .catch(() => { if (!cancelled) setFailed(true); });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [requestKey, from]);

  const data = result?.data;
  const loading = !data && !failed;

  const title = (sec: Section): string => t(`closest.suggest.sections.${sec}`);
  const rowsFor = (sec: Section): Found[] | undefined =>
    data?.[sec === 'service' ? `service:${shownService}` : sec];

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${styles.modal}`} role="dialog" aria-modal="true" aria-labelledby="closest-suggest-title">
        <div className="modal__header">
          <h2 className="modal__title" id="closest-suggest-title">{t('closest.suggest.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={16} weight="bold" />
          </button>
        </div>
        <div className={`modal__body ${styles.body}`}>
          <p className={styles.hint}>{t('closest.suggest.hint')}</p>
          {failed && <p className={styles.empty}>{t('closest.suggest.failed')}</p>}
          {SECTIONS.map((sec) => {
            const rows = rowsFor(sec);
            return (
              <section key={sec} className={styles.section}>
                <div className={styles.head}>
                  <h3 className={styles.title}>{title(sec)}</h3>
                  {sec === 'service' && (
                    <Select id="suggest-service" value={shownService} onChange={(v) => setService(v as Service)}
                      options={SERVICES.map((sv) => ({ value: sv, label: t(`closest.suggest.services.${sv}`) }))} />
                  )}
                </div>
                {sec === 'quiet' && <p className={styles.note}>{t('closest.suggest.quietHint')}</p>}
                {sec === 'concord' && <p className={styles.note}>{t('closest.suggest.concordHint')}</p>}
                {loading ? (
                  <p className={styles.empty}>{t('closest.suggest.loading')}</p>
                ) : !rows || rows.length === 0 ? (
                  <p className={styles.empty}>{t(`closest.suggest.none.${emptyReason(sec, clones.enabled)}`)}</p>
                ) : (
                  <ul className={styles.list}>
                    {rows.map((r) => {
                      const end = r.path[r.path.length - 1];
                      const name = end?.name ?? String(r.id);
                      const already = onList.has(r.id);
                      return (
                        <li key={r.id} className={styles.row}>
                          <span className={styles.name}>{aliasName(name)}</span>
                          {end && end.kspace && (
                            <span className={styles.sec} style={{ color: truesecColor(end.security) }}>
                              {end.security.toFixed(1)}
                            </span>
                          )}
                          <span className={styles.jumps}>{jumpsLabel(t, r.jumps)}</span>
                          {/* Every buyer seen so far takes all four, so only say so when one doesn't. */}
                          {r.detail && r.detail.length > 0 && r.detail.length < Object.keys(BLUE_LOOT).length && (
                            <span className={styles.detail}>{r.detail.map((id) => BLUE_LOOT[id] ?? id).join(', ')}</span>
                          )}
                          <button type="button" className={`sys-btn ${styles.add}`}
                            onClick={() => (already ? onRemove(r.id) : onAdd(r.id, name))}>
                            {already
                              ? <><MinusIcon size={12} weight="bold" /> {t('closest.removeFromList')}</>
                              : <><PlusIcon size={12} weight="bold" /> {t('addSystem.add')}</>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Why a section is empty, for a message that helps. */
function emptyReason(sec: Section, clonesEnabled: boolean): 'clone' | 'clonesOff' | 'blueloot' | 'scout' | 'structure' | 'incursion' | 'generic' {
  if (sec === 'clone') return clonesEnabled ? 'clone' : 'clonesOff';
  if (sec === 'blueloot') return 'blueloot';
  if (sec === 'thera' || sec === 'turnur') return 'scout';
  if (sec === 'structure') return 'structure';
  if (sec === 'incursion') return 'incursion';
  return 'generic';
}
