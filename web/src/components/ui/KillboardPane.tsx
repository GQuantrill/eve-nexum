import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useKillboard, useLastKill, KILL_WINDOWS, type KillTag, type KillWindow } from '../../hooks/useKillboard';
import { useMapStore } from '../../store/mapStore';
import { useShareMode } from '../../context/ShareModeContext';
import { useStandings } from '../../hooks/useStandings';
import { useUserSetting } from '../../hooks/useUserSetting';
import { useNow30s } from '../../hooks/useNow30s';
import { useSystemKillLog, useKillLog, RECENT_KILL_MS, type KillRow as FeedKill } from '../../store/killStore';
import { abbreviateValue, splitHoursMinutes } from '../../i18n/format';
import type { ZkbKill } from '../../hooks/useKillboard';
import styles from './KillboardPane.module.css';

// Adapt a live kill-feed row into the zKill shape the panel renders. We only
// have the final-blow attacker from the feed, so `attackers` holds just that.
function killRowToZkb(r: FeedKill): ZkbKill {
  return {
    killmail_id:   r.killmailId,
    killmail_time: new Date(r.atMs).toISOString(),
    victim: {
      character_id:     r.victimCharacterId ?? undefined,
      character_name:   r.victimName ?? undefined,
      corporation_id:   r.victimCorporationId ?? undefined,
      corporation_name: r.victimCorpName ?? undefined,
      ship_type_id:     r.shipTypeId,
    },
    attackers: r.finalBlow ? [{
      final_blow:       true,
      character_id:     r.finalBlow.characterId ?? undefined,
      character_name:   r.finalBlow.name ?? undefined,
      corporation_id:   r.finalBlow.corporationId ?? undefined,
      corporation_name: r.finalBlow.corpName ?? undefined,
      ship_type_id:     r.finalBlow.shipTypeId || undefined,
    }] : [],
    zkb: { hash: '', totalValue: r.totalValue, solo: false, npc: r.npc },
  };
}

const NPC_TOGGLE_KEY = 'nexum.killboardIncludeNpc';
const WINDOW_KEY = 'nexum.killboard.window';
const SCOPE_KEY  = 'nexum.killboard.scope';
const WINDOW_MS: Record<KillWindow, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 };

// Shown as chips on a kill. Solo is left out: the attacker-count badge already
// says "1".
const SHOWN_TAGS: KillTag[] = ['gate', 'hic', 'dic', 'sb', 'npc'];

// How many kills to reveal initially and per "Load more" click. Sized to
// match what fit on a single page under the old paginator so the default
// view density hasn't changed.
const PAGE_SIZE = 5;

const EVE_IMG = 'https://images.evetech.net';
const ZKB     = 'https://zkillboard.com';
// At or above this many attackers a kill is treated as a "gank" (overwhelming
// force) rather than a small gang. Tune to taste.
const GANK_THRESHOLD = 10;

// Killboard uses a finer-grained "time ago" than the shared timeAgo (h+m
// combined, e.g. "3h 24m ago"), so it stays its own function — but the h/m
// split now comes from the shared helper.
function timeAgo(t: TFunction, iso: string): string {
  const { hours: h, minutes: m } = splitHoursMinutes(Date.now() - new Date(iso).getTime());
  if (h >= 24) return t('time.daysAgo', { value: Math.floor(h / 24) });
  if (h > 0)   return t('killboard.hoursMinutesAgo', { hours: h, minutes: m });
  return m <= 0 ? t('time.justNow') : t('time.minutesAgo', { value: m });
}

function ZkbLink({ href, tip, children }: { href: string; tip: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      data-tip={tip}
      target="_blank"
      rel="noreferrer"
      className={styles.iconLink}
    >
      {children}
    </a>
  );
}

function EntityCol({ characterId, characterName, corporationId, corporationName, allianceId, allianceName, label, align, nameSuffix }: {
  characterId?:     number;
  characterName?:   string;
  corporationId?:   number;
  corporationName?: string;
  allianceId?:      number;
  allianceName?:    string;
  label:            string;
  /** Text alignment for the name column — 'left' for victim, 'right' for attacker. */
  align:            'left' | 'right';
  /** Optional text after the character name, e.g. "+14" for the other attackers. */
  nameSuffix?:      string;
}) {
  const { t } = useTranslation();
  // Row layout: portrait, then a names column with character on top and
  // corp / alliance lines beneath. Affiliation icons render with the
  // names so the eye can scan icons or text equally well.
  const portrait = characterId && (
    <ZkbLink href={`${ZKB}/character/${characterId}/`} tip={t('killboard.onZkb', { label })}>
      <img className={`${styles.icon} ${styles.iconPortrait}`} src={`${EVE_IMG}/characters/${characterId}/portrait?size=64`} alt="" loading="lazy" />
    </ZkbLink>
  );

  const names = (characterId || corporationId || allianceId) ? (
    <div className={`${styles.names} ${align === 'left' ? styles.namesLeft : styles.namesRight}`}>
      {characterId && (
        <a href={`${ZKB}/character/${characterId}/`} target="_blank" rel="noreferrer" className={`${styles.name} ${styles.nameChar}`}>
          {characterName ?? '…'}{nameSuffix && <span className={styles.nameSuffix}> {nameSuffix}</span>}
        </a>
      )}
      {corporationId && (
        <a href={`${ZKB}/corporation/${corporationId}/`} target="_blank" rel="noreferrer" className={`${styles.name} ${styles.nameAffil}`}>
          <img className={styles.nameIcon} src={`${EVE_IMG}/corporations/${corporationId}/logo?size=32`} alt="" loading="lazy" />
          <span>{corporationName ?? '…'}</span>
        </a>
      )}
      {allianceId && (
        <a href={`${ZKB}/alliance/${allianceId}/`} target="_blank" rel="noreferrer" className={`${styles.name} ${styles.nameAffil}`}>
          <img className={styles.nameIcon} src={`${EVE_IMG}/alliances/${allianceId}/logo?size=32`} alt="" loading="lazy" />
          <span>{allianceName ?? '…'}</span>
        </a>
      )}
    </div>
  ) : null;

  return (
    <div className={styles.entityCol}>
      {align === 'left'
        ? <>{portrait}{names}</>
        : <>{names}{portrait}</>}
    </div>
  );
}

// Lookup the most extreme standing for an entity across its corp + alliance.
// Returns 0 when the entity has no contact entries in any bucket, so the
// rest of the row's tint logic can treat "no signal" as neutral.
function entityStanding(
  standings: ReturnType<typeof useStandings>,
  corpId?: number,
  allianceId?: number,
): number {
  if (!standings.loaded) return 0;
  const values: number[] = [];
  if (corpId)     values.push(standings.getStanding('corporation', corpId).effective);
  if (allianceId) values.push(standings.getStanding('alliance',    allianceId).effective);
  const nonZero = values.filter((v) => v !== 0);
  if (!nonZero.length) return 0;
  // Pick the extremum farthest from zero — a single +5 still flags blue
  // even if the other bucket is neutral.
  return nonZero.reduce((a, b) => (Math.abs(a) >= Math.abs(b) ? a : b));
}

// Combine victim + final-blow attacker into a single row tint. Priority
// from an FC's POV: hostile actor in the chain or losing a blue are the
// signals worth flagging in red. A blue scoring or a hostile dying tilt
// it green.
function killRowTint(victim: number, killer: number): string {
  // Bad: a hostile actor is killing things here, or we just lost a blue.
  if (killer < 0 || victim > 0) return styles.killBad;
  // Good: a friendly scored, or someone we'd flagged died.
  if (killer > 0 || victim < 0) return styles.killGood;
  return '';
}

function KillRow({ kill, standings, pulse }: { kill: ZkbKill; standings: ReturnType<typeof useStandings>; pulse?: boolean }) {
  const { t } = useTranslation();
  const isPod      = kill.victim.ship_type_id === 670;
  const v          = kill.victim;
  const fbAttacker = kill.attackers.find((a) => a.final_blow);

  const victimStanding = entityStanding(standings, v.corporation_id, v.alliance_id);
  const killerStanding = entityStanding(standings, fbAttacker?.corporation_id, fbAttacker?.alliance_id);
  const tint           = killRowTint(victimStanding, killerStanding);

  return (
    <div className={[styles.kill, isPod && styles.killPod, pulse && styles.killLive, tint].filter(Boolean).join(' ')}>
      {pulse && <span className={styles.liveDot} data-tip={t('killboard.live')} aria-label={t('killboard.live')} />}
      {/* Victim side: victim ship → victim affiliations */}
      <span className={styles.shipWrap}>
        <a
          href={`${ZKB}/kill/${kill.killmail_id}/`}
          target="_blank"
          rel="noreferrer"
          data-tip={t('killboard.viewKillmail')}
          className={styles.iconLink}
        >
          <img
            className={styles.ship}
            src={`${EVE_IMG}/types/${v.ship_type_id}/render?size=64`}
            alt=""
            loading="lazy"
          />
        </a>
        {kill.zkb.solo || kill.attackers.length === 1 ? (
          <span className={`${styles.count} ${styles.countSolo}`} data-tip={t('killboard.soloKill')}>1</span>
        ) : kill.attackers.length > 1 ? (
          <span
            className={[styles.count, kill.attackers.length >= GANK_THRESHOLD && styles.countGank].filter(Boolean).join(' ')}
            data-tip={
              kill.attackers.length >= GANK_THRESHOLD
                ? t('killboard.gank', { count: kill.attackers.length })
                : t('killboard.attackers', { count: kill.attackers.length })
            }
          >
            {kill.attackers.length}
          </span>
        ) : null}
      </span>

      <EntityCol
        characterId={v.character_id}
        characterName={v.character_name}
        corporationId={v.corporation_id}
        corporationName={v.corporation_name}
        allianceId={v.alliance_id}
        allianceName={v.alliance_name}
        label={t('killboard.victim')}
        align="left"
      />

      {/* Right cluster: attacker block (if any) + ISK/time meta. Wrapping
          keeps the layout sane when there's no final-blow attacker — the
          cluster's margin-left:auto pushes meta to the right edge by itself. */}
      <div className={styles.right}>
        {fbAttacker && (
          <div className={styles.attacker}>
            <EntityCol
              characterId={fbAttacker.character_id}
              characterName={fbAttacker.character_name}
              corporationId={fbAttacker.corporation_id}
              corporationName={fbAttacker.corporation_name}
              allianceId={fbAttacker.alliance_id}
              allianceName={fbAttacker.alliance_name}
              label={t('killboard.finalBlow')}
              align="right"
              nameSuffix={kill.attackers.length > 1 ? `+${kill.attackers.length - 1}` : undefined}
            />
            {fbAttacker.ship_type_id && (
              <span className={styles.shipWrap} data-tip={t('killboard.finalBlowShip')}>
                <img
                  className={`${styles.ship} ${styles.shipAttacker}`}
                  src={`${EVE_IMG}/types/${fbAttacker.ship_type_id}/render?size=64`}
                  alt=""
                  loading="lazy"
                />
              </span>
            )}
          </div>
        )}

        <div className={styles.killMeta}>
          <span className={styles.value}>{abbreviateValue(kill.zkb.totalValue)} ISK</span>
          <span className={styles.time}>
            {kill.systemName && <span className={styles.killSystem}>{kill.systemName} · </span>}
            {timeAgo(t, kill.killmail_time)}
          </span>
          {kill.tags && kill.tags.some((tag) => SHOWN_TAGS.includes(tag)) && (
            <span className={styles.tags}>
              {SHOWN_TAGS.filter((tag) => kill.tags!.includes(tag)).map((tag) => (
                <span key={tag} className={`${styles.tag} ${styles[`tag_${tag}`] ?? ''}`} data-tip={t(`killboard.tagTips.${tag}`)}>
                  {t(`killboard.tags.${tag}`)}
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

interface Props {
  eveSystemId: number | null;
}

export function KillboardPane({ eveSystemId }: Props) {
  const { t } = useTranslation();
  const [includeNpc, setIncludeNpc] = useUserSetting<boolean>(NPC_TOGGLE_KEY, false);

  const [windowRaw, setWindow] = useUserSetting<string>(WINDOW_KEY, '24h');
  const killWindow: KillWindow = (KILL_WINDOWS as string[]).includes(windowRaw) ? (windowRaw as KillWindow) : '24h';
  const [scopeRaw, setScope] = useUserSetting<string>(SCOPE_KEY, 'system');
  const activeMapId = useMapStore((s) => s.activeMapId);
  const { isShareMode } = useShareMode();
  // The whole-map list is a signed-in map's; a share-link viewer stays on the system.
  const canMapScope = !!activeMapId && !isShareMode;
  const mapScope = scopeRaw === 'map' && canMapScope;

  const { kills, total, loading, error, lastUpdated, npcCount, refresh } = useKillboard(eveSystemId, {
    includeNpc, window: killWindow, mapId: mapScope ? activeMapId : null,
  });
  const standings = useStandings();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Merge the live kill feed for this system with the zKill REST list so recent
  // notable kills show immediately, without waiting on zKill's cached REST API.
  const systemLive = useSystemKillLog(eveSystemId);
  const mapLive    = useKillLog();
  const now        = useNow30s();
  const liveRows   = useMemo(
    () => (mapScope ? mapLive : systemLive).filter((r) => now - r.atMs < WINDOW_MS[killWindow]),
    [mapScope, mapLive, systemLive, now, killWindow],
  );
  const liveIds  = useMemo(() => new Set(liveRows.map((r) => r.killmailId)), [liveRows]);
  const mergedKills = useMemo(() => {
    const byId = new Map<number, ZkbKill>();
    for (const k of kills) byId.set(k.killmail_id, k); // REST first — fuller attacker list wins on overlap
    for (const r of liveRows) {
      if (!includeNpc && r.npc) continue;              // respect the NPC toggle for live rows too
      if (!byId.has(r.killmailId)) byId.set(r.killmailId, { ...killRowToZkb(r), ...(mapScope ? { systemName: r.systemName } : {}) });
    }
    return [...byId.values()].sort((a, b) => Date.parse(b.killmail_time) - Date.parse(a.killmail_time));
  }, [kills, liveRows, includeNpc, mapScope]);

  // Nothing in the last 24h (and not merely NPC-filtered) → look up the last
  // kill of any age so the pane can say "last kill was X ago" instead of a bare
  // "no kills". Gated so active systems never trigger the extra lookup.
  const trulyEmpty     = !mapScope && !loading && !error && kills.length === 0 && !(npcCount > 0 && !includeNpc);
  const lastKillTime   = useLastKill(eveSystemId, trulyEmpty);

  // Reset the lazy window whenever the system or filter changes — otherwise
  // a system with 8 visible kills carries over its expanded count to the
  // next system the user clicks on, which is jarring.
  // Deliberate: resets paging when the system changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [eveSystemId, includeNpc, killWindow, mapScope]);

  if (!eveSystemId && !mapScope) {
    return <p className={styles.state}>{t('panes.noEveSystem')}</p>;
  }

  const visibleKills = mergedKills.slice(0, visibleCount);
  const hasMore      = visibleCount < mergedKills.length;

  // Render the meta row (with the NPC toggle) regardless of whether there
  // are kills to show — otherwise the user has no way to flip the toggle
  // when the filter is hiding every kill.
  return (
    <div className={styles.pane}>
      <div className={styles.controls}>
        {canMapScope && (
          <span className={styles.seg} role="group" aria-label={t('killboard.scopeLabel')}>
            {(['system', 'map'] as const).map((sc) => (
              <button
                key={sc}
                type="button"
                className={`${styles.segBtn}${(sc === 'map') === mapScope ? ` ${styles.segOn}` : ''}`}
                aria-pressed={(sc === 'map') === mapScope}
                onClick={() => setScope(sc)}
              >
                {sc === 'map' ? t('killboard.scopeMap') : t('killboard.scopeSystem')}
              </button>
            ))}
          </span>
        )}
        <span className={styles.seg} role="group" aria-label={t('killboard.windowLabel')}>
          {KILL_WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={`${styles.segBtn}${w === killWindow ? ` ${styles.segOn}` : ''}`}
              aria-pressed={w === killWindow}
              onClick={() => setWindow(w)}
            >
              {t(`killboard.window.${w}`)}
            </button>
          ))}
        </span>
      </div>
      <div className={styles.paneMeta}>
        <span>
          {/* Only when the server capped the list -- not because NPC kills are hidden. */}
          {total != null && total > kills.length + (includeNpc ? 0 : npcCount)
            ? t('killboard.showingOf', { shown: mergedKills.length, total })
            : t('units.kills', { count: mergedKills.length })}
          {!includeNpc && npcCount > 0 && (
            <span className={styles.npcHidden} data-tooltip={t('killboard.npcHiddenTooltip')}>
              {' '}· {t('killboard.npcHidden', { count: npcCount })}
            </span>
          )}
          {lastUpdated && <> · {t('killboard.updated', { time: timeAgo(t, lastUpdated.toISOString()) })}</>}
        </span>
        <label className={styles.npcToggle} data-tooltip={t('killboard.includeNpcTooltip')}>
          <input
            type="checkbox"
            checked={includeNpc}
            onChange={(e) => {
              setIncludeNpc(e.target.checked);
              // Toggling is also a signal of "show me what's actually
              // there" — force a refetch so the user isn't looking at
              // stale data from the 5-minute cache.
              refresh(true);
            }}
          />
          <span>{t('killboard.showNpcKills')}</span>
        </label>
      </div>

      {loading && mergedKills.length === 0 ? (
        <p className={styles.state}>{t('killboard.loading')}</p>
      ) : error && mergedKills.length === 0 ? (
        <p className={`${styles.state} ${styles.stateError}`}>{error}</p>
      ) : mergedKills.length === 0 ? (
        <p className={styles.state}>
          {!includeNpc && npcCount > 0 ? (
            <>
              {t('killboard.noKillsNpc', { count: npcCount })}{' '}
              <button type="button" className={styles.inlineToggle} onClick={() => { setIncludeNpc(true); refresh(true); }}>{t('killboard.showThem')}</button>
            </>
          ) : lastKillTime === null ? (
            t('killboard.noKillsOnRecord')
          ) : lastKillTime ? (
            t('killboard.lastKillAgo', { time: timeAgo(t, lastKillTime) })
          ) : (
            t('killboard.noKills')
          )}
        </p>
      ) : (
        <div className={styles.list}>
          {visibleKills.map((k) => (
            <KillRow
              key={k.killmail_id}
              kill={k}
              standings={standings}
              pulse={liveIds.has(k.killmail_id) && now - Date.parse(k.killmail_time) < RECENT_KILL_MS}
            />
          ))}
          {hasMore && (
            <button
              type="button"
              className={styles.loadMore}
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            >
              {t('killboard.loadMore', { count: mergedKills.length - visibleCount })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
