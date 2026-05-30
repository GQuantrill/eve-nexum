import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useKillboard } from '../../hooks/useKillboard';
import { useStandings } from '../../hooks/useStandings';
import { useUserSetting } from '../../hooks/useUserSetting';
import { abbreviateValue } from '../../i18n/format';
import type { ZkbKill } from '../../hooks/useKillboard';

const NPC_TOGGLE_KEY = 'nexum.killboardIncludeNpc';

// How many kills to reveal initially and per "Load more" click. Sized to
// match what fit on a single page under the old paginator so the default
// view density hasn't changed.
const PAGE_SIZE = 5;

const EVE_IMG = 'https://images.evetech.net';
const ZKB     = 'https://zkillboard.com';
// At or above this many attackers a kill is treated as a "gank" (overwhelming
// force) rather than a small gang. Tune to taste.
const GANK_THRESHOLD = 10;

function timeAgo(t: TFunction, iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diffMs / 3_600_000);
  const m = Math.floor((diffMs % 3_600_000) / 60_000);
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
      className="zkb-kill__icon-link"
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
      <img className="zkb-kill__icon zkb-kill__icon--portrait" src={`${EVE_IMG}/characters/${characterId}/portrait?size=64`} alt="" loading="lazy" />
    </ZkbLink>
  );

  const names = (characterId || corporationId || allianceId) ? (
    <div className={`zkb-kill__names zkb-kill__names--${align}`}>
      {characterId && (
        <a href={`${ZKB}/character/${characterId}/`} target="_blank" rel="noreferrer" className="zkb-kill__name zkb-kill__name--char">
          {characterName ?? '…'}{nameSuffix && <span className="zkb-kill__name-suffix"> {nameSuffix}</span>}
        </a>
      )}
      {corporationId && (
        <a href={`${ZKB}/corporation/${corporationId}/`} target="_blank" rel="noreferrer" className="zkb-kill__name zkb-kill__name--affil">
          <img className="zkb-kill__name-icon" src={`${EVE_IMG}/corporations/${corporationId}/logo?size=32`} alt="" loading="lazy" />
          <span>{corporationName ?? '…'}</span>
        </a>
      )}
      {allianceId && (
        <a href={`${ZKB}/alliance/${allianceId}/`} target="_blank" rel="noreferrer" className="zkb-kill__name zkb-kill__name--affil">
          <img className="zkb-kill__name-icon" src={`${EVE_IMG}/alliances/${allianceId}/logo?size=32`} alt="" loading="lazy" />
          <span>{allianceName ?? '…'}</span>
        </a>
      )}
    </div>
  ) : null;

  return (
    <div className={`zkb-kill__entity-col zkb-kill__entity-col--${align}`}>
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
function killRowTint(victim: number, killer: number): '' | 'zkb-kill--bad' | 'zkb-kill--good' {
  // Bad: a hostile actor is killing things here, or we just lost a blue.
  if (killer < 0 || victim > 0) return 'zkb-kill--bad';
  // Good: a friendly scored, or someone we'd flagged died.
  if (killer > 0 || victim < 0) return 'zkb-kill--good';
  return '';
}

function KillRow({ kill, standings }: { kill: ZkbKill; standings: ReturnType<typeof useStandings> }) {
  const { t } = useTranslation();
  const isPod      = kill.victim.ship_type_id === 670;
  const v          = kill.victim;
  const fbAttacker = kill.attackers.find((a) => a.final_blow);

  const victimStanding = entityStanding(standings, v.corporation_id, v.alliance_id);
  const killerStanding = entityStanding(standings, fbAttacker?.corporation_id, fbAttacker?.alliance_id);
  const tint           = killRowTint(victimStanding, killerStanding);

  return (
    <div className={`zkb-kill${isPod ? ' zkb-kill--pod' : ''}${tint ? ` ${tint}` : ''}`}>
      {/* Victim side: victim ship → victim affiliations */}
      <span className="zkb-kill__ship-wrap">
        <a
          href={`${ZKB}/kill/${kill.killmail_id}/`}
          target="_blank"
          rel="noreferrer"
          data-tip={t('killboard.viewKillmail')}
          className="zkb-kill__icon-link"
        >
          <img
            className="zkb-kill__ship"
            src={`${EVE_IMG}/types/${v.ship_type_id}/render?size=64`}
            alt=""
            loading="lazy"
          />
        </a>
        {kill.zkb.solo || kill.attackers.length === 1 ? (
          <span className="zkb-kill__count zkb-kill__count--solo" data-tip={t('killboard.soloKill')}>1</span>
        ) : kill.attackers.length > 1 ? (
          <span
            className={`zkb-kill__count${kill.attackers.length >= GANK_THRESHOLD ? ' zkb-kill__count--gank' : ''}`}
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
      <div className="zkb-kill__right">
        {fbAttacker && (
          <div className="zkb-kill__attacker">
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
              <span className="zkb-kill__ship-wrap" data-tip={t('killboard.finalBlowShip')}>
                <img
                  className="zkb-kill__ship zkb-kill__ship--attacker"
                  src={`${EVE_IMG}/types/${fbAttacker.ship_type_id}/render?size=64`}
                  alt=""
                  loading="lazy"
                />
              </span>
            )}
          </div>
        )}

        <div className="zkb-kill__meta">
          <span className="zkb-kill__value">{abbreviateValue(kill.zkb.totalValue)} ISK</span>
          <span className="zkb-kill__time">{timeAgo(t, kill.killmail_time)}</span>
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

  const { kills, loading, error, lastUpdated, npcCount, refresh } = useKillboard(eveSystemId, { includeNpc });
  const standings = useStandings();
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Reset the lazy window whenever the system or filter changes — otherwise
  // a system with 8 visible kills carries over its expanded count to the
  // next system the user clicks on, which is jarring.
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [eveSystemId, includeNpc]);

  if (!eveSystemId) {
    return <p className="zkb-state">{t('panes.noEveSystem')}</p>;
  }

  const visibleKills = kills.slice(0, visibleCount);
  const hasMore      = visibleCount < kills.length;

  // Render the meta row (with the NPC toggle) regardless of whether there
  // are kills to show — otherwise the user has no way to flip the toggle
  // when the filter is hiding every kill.
  return (
    <div className="zkb-pane">
      <div className="zkb-pane__meta">
        <span>
          {t('units.kills', { count: kills.length })}
          {!includeNpc && npcCount > 0 && (
            <span className="zkb-pane__npc-hidden" data-tooltip={t('killboard.npcHiddenTooltip')}>
              {' '}· {t('killboard.npcHidden', { count: npcCount })}
            </span>
          )}
          {lastUpdated && <> · {t('killboard.updated', { time: timeAgo(t, lastUpdated.toISOString()) })}</>}
        </span>
        <label className="zkb-pane__npc-toggle" data-tooltip={t('killboard.includeNpcTooltip')}>
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

      {loading && kills.length === 0 ? (
        <p className="zkb-state">{t('killboard.loading')}</p>
      ) : error ? (
        <p className="zkb-state zkb-state--error">{error}</p>
      ) : kills.length === 0 ? (
        <p className="zkb-state">
          {!includeNpc && npcCount > 0 ? (
            <>
              {t('killboard.noKillsNpc', { count: npcCount })}{' '}
              <button type="button" className="zkb-pane__inline-toggle" onClick={() => { setIncludeNpc(true); refresh(true); }}>{t('killboard.showThem')}</button>
            </>
          ) : (
            t('killboard.noKills')
          )}
        </p>
      ) : (
        <div className="zkb-pane__list">
          {visibleKills.map((k) => <KillRow key={k.killmail_id} kill={k} standings={standings} />)}
          {hasMore && (
            <button
              type="button"
              className="zkb-pane__load-more"
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            >
              {t('killboard.loadMore', { count: kills.length - visibleCount })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
