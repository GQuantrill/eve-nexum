import { useState } from 'react';
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import { useKillboard } from '../../hooks/useKillboard';
import { useStandings } from '../../hooks/useStandings';
import { useUserSetting } from '../../hooks/useUserSetting';
import type { ZkbKill } from '../../hooks/useKillboard';

const NPC_TOGGLE_KEY = 'nexum.killboardIncludeNpc';

const PAGE_SIZE = 5;

const EVE_IMG = 'https://images.evetech.net';
const ZKB     = 'https://zkillboard.com';

function formatIsk(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(Math.round(v));
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diffMs / 3_600_000);
  const m = Math.floor((diffMs % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ago`;
  if (h > 0)   return `${h}h ${m}m ago`;
  return m <= 0 ? 'just now' : `${m}m ago`;
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

function EntityCol({ characterId, corporationId, allianceId, label }: {
  characterId?:   number;
  corporationId?: number;
  allianceId?:    number;
  label:          string;
}) {
  return (
    <div className="zkb-kill__entity-col">
      {characterId ? (
        <ZkbLink href={`${ZKB}/character/${characterId}/`} tip={`${label} on zKillboard`}>
          <img className="zkb-kill__icon" src={`${EVE_IMG}/characters/${characterId}/portrait?size=32`} alt="" loading="lazy" />
        </ZkbLink>
      ) : corporationId ? (
        <ZkbLink href={`${ZKB}/corporation/${corporationId}/`} tip={`${label} corporation on zKillboard`}>
          <img className="zkb-kill__icon" src={`${EVE_IMG}/corporations/${corporationId}/logo?size=32`} alt="" loading="lazy" />
        </ZkbLink>
      ) : null}
      {corporationId && (
        <ZkbLink href={`${ZKB}/corporation/${corporationId}/`} tip="Corporation on zKillboard">
          <img className="zkb-kill__icon" src={`${EVE_IMG}/corporations/${corporationId}/logo?size=32`} alt="" loading="lazy" />
        </ZkbLink>
      )}
      {allianceId && (
        <ZkbLink href={`${ZKB}/alliance/${allianceId}/`} tip="Alliance on zKillboard">
          <img className="zkb-kill__icon" src={`${EVE_IMG}/alliances/${allianceId}/logo?size=32`} alt="" loading="lazy" />
        </ZkbLink>
      )}
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
  const isPod      = kill.victim.ship_type_id === 670;
  const v          = kill.victim;
  const fbAttacker = kill.attackers.find((a) => a.final_blow);

  const victimStanding = entityStanding(standings, v.corporation_id, v.alliance_id);
  const killerStanding = entityStanding(standings, fbAttacker?.corporation_id, fbAttacker?.alliance_id);
  const tint           = killRowTint(victimStanding, killerStanding);

  return (
    <div className={`zkb-kill${isPod ? ' zkb-kill--pod' : ''}${tint ? ` ${tint}` : ''}`}>
      <a
        href={`${ZKB}/kill/${kill.killmail_id}/`}
        target="_blank"
        rel="noreferrer"
        data-tip="View killmail on zKillboard"
        className="zkb-kill__icon-link"
      >
        <img
          className="zkb-kill__ship"
          src={`${EVE_IMG}/types/${v.ship_type_id}/render?size=64`}
          alt=""
          loading="lazy"
        />
      </a>

      <div className="zkb-kill__info">
        <div className="zkb-kill__row1">
          <EntityCol
            characterId={v.character_id}
            corporationId={v.corporation_id}
            allianceId={v.alliance_id}
            label="Victim"
          />
          {kill.zkb.solo && (
            <span className="zkb-kill__badge zkb-kill__badge--solo">Solo</span>
          )}
          {!kill.zkb.solo && kill.attackers.length > 1 && (
            <span className="zkb-kill__badge">+{kill.attackers.length}</span>
          )}
        </div>
        <div className="zkb-kill__row2">
          <span className="zkb-kill__value">{formatIsk(kill.zkb.totalValue)} ISK</span>
        </div>
        <div className="zkb-kill__row3">
          <span className="zkb-kill__time">{timeAgo(kill.killmail_time)}</span>
        </div>
      </div>

      {fbAttacker && (
        <EntityCol
          characterId={fbAttacker.character_id}
          corporationId={fbAttacker.corporation_id}
          allianceId={fbAttacker.alliance_id}
          label="Final blow"
        />
      )}
    </div>
  );
}

interface Props {
  eveSystemId: number | null;
}

export function KillboardPane({ eveSystemId }: Props) {
  const [includeNpc, setIncludeNpc] = useUserSetting<boolean>(NPC_TOGGLE_KEY, false);

  const { kills, loading, error, lastUpdated, npcCount, refresh } = useKillboard(eveSystemId, { includeNpc });
  const standings = useStandings();
  const [page, setPage] = useState(0);

  if (!eveSystemId) {
    return <p className="zkb-state">No EVE system linked.</p>;
  }

  const totalPages = Math.max(1, Math.ceil(kills.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages - 1);
  const pageKills  = kills.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  // Render the meta row (with the NPC toggle) regardless of whether there
  // are kills to show — otherwise the user has no way to flip the toggle
  // when the filter is hiding every kill.
  return (
    <div className="zkb-pane">
      <div className="zkb-pane__meta">
        <span>
          {kills.length} kill{kills.length !== 1 ? 's' : ''}
          {!includeNpc && npcCount > 0 && (
            <span className="zkb-pane__npc-hidden" data-tooltip="NPC-only kills (CONCORD, rats, etc.) hidden">
              {' '}· {npcCount} NPC hidden
            </span>
          )}
          {lastUpdated && <> · updated {timeAgo(lastUpdated.toISOString())}</>}
        </span>
        <label className="zkb-pane__npc-toggle" data-tooltip="Include NPC-only killmails in the feed">
          <input
            type="checkbox"
            checked={includeNpc}
            onChange={(e) => {
              setIncludeNpc(e.target.checked);
              setPage(0);
              // Toggling is also a signal of "show me what's actually
              // there" — force a refetch so the user isn't looking at
              // stale data from the 5-minute cache.
              refresh(true);
            }}
          />
          <span>Show NPC kills</span>
        </label>
        {totalPages > 1 && (
          <span className="zkb-pane__pages">
            <button
              type="button"
              className="zkb-page-btn"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
            ><CaretLeftIcon size={14} weight="bold" /></button>
            <span className="zkb-pane__page-label">{safePage + 1} / {totalPages}</span>
            <button
              type="button"
              className="zkb-page-btn"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={safePage === totalPages - 1}
            ><CaretRightIcon size={14} weight="bold" /></button>
          </span>
        )}
      </div>

      {loading && kills.length === 0 ? (
        <p className="zkb-state">Loading kills…</p>
      ) : error ? (
        <p className="zkb-state zkb-state--error">{error}</p>
      ) : kills.length === 0 ? (
        <p className="zkb-state">
          No kills in the last 24h
          {!includeNpc && npcCount > 0 && (
            <> — {npcCount} NPC-only hidden. <button type="button" className="zkb-pane__inline-toggle" onClick={() => { setIncludeNpc(true); refresh(true); }}>Show them</button></>
          )}
          .
        </p>
      ) : (
        <div className="zkb-pane__list">
          {pageKills.map((k) => <KillRow key={k.killmail_id} kill={k} standings={standings} />)}
        </div>
      )}
    </div>
  );
}
