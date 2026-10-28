import i18n from '../i18n';
import { toast } from './toastStore';
import { useMapStore } from '../store/mapStore';
import type { KillRow } from '../store/killStore';
import { systemDisplayName } from './systemName';
import { abbreviateValue } from '../i18n/format';
import {
  NOTIFY, notifyOn, anyChannelOn, alertGain, fireDesktopNotification,
  KILLS_FILTER_KEY, KILLS_FILTER_DEFAULT, type KillsFilter,
} from './notificationPrefs';
import { readUserSetting } from '../hooks/useUserSetting';

// In-app notifications for things happening on the chain that aren't about
// you specifically: a kill on the map, and a hole someone has marked end of
// life. Both opt-in, like K162 and exits, with the toast gated too so both
// channels off means silence.

let audioCtx: AudioContext | null = null;

// Two quick notes, so each reads as a different alert from the single-tone
// K162 (1320 saw), watchlist (988 triangle), proximity (880 sine) and exit
// (660 square) chimes.
function playTwoTone(first: number, second: number, type: OscillatorType, peak: number) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const ctx = audioCtx;
    if (ctx.state === 'suspended') void ctx.resume();
    [first, second].forEach((freq, i) => {
      const start = ctx.currentTime + i * 0.16;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = freq;
      o.type = type;
      g.gain.setValueAtTime(0.001, start);
      g.gain.exponentialRampToValueAtTime(alertGain(peak), start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.14);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(start);
      o.stop(start + 0.16);
    });
  } catch { /* audio blocked / unavailable — silent fail */ }
}

const BILLION_ISK = 1_000_000_000;

function killMatches(kill: KillRow, filter: KillsFilter): boolean {
  switch (filter) {
    case 'all':     return true;
    case 'billion': return kill.totalValue >= BILLION_ISK;
    default:        return (kill.special?.length ?? 0) > 0;
  }
}

/** A live kill in a system on the active map. */
export function alertKill(kill: KillRow): void {
  if (!anyChannelOn(NOTIFY.killsDesktop, NOTIFY.killsSound)) return;
  const filter = readUserSetting<KillsFilter>(KILLS_FILTER_KEY, KILLS_FILTER_DEFAULT);
  if (!killMatches(kill, filter)) return;

  const t = i18n.t.bind(i18n);
  const why = (kill.special ?? []).map((k) => t(`alerts.special.${k}` as 'alerts.special.capital')).join(', ');
  const body = t('alerts.killBody', {
    victim: kill.victimName ?? kill.victimCorpName ?? t('alerts.someone'),
    ship:   kill.shipTypeName || t('alerts.aShip'),
    value:  abbreviateValue(kill.totalValue),
  }) + (why ? ` · ${why}` : '');
  const title = t('alerts.killTitle', { system: kill.systemName });

  toast.info(`${title}: ${body}`);
  if (notifyOn(NOTIFY.killsDesktop)) fireDesktopNotification(title, body, `nexum-kill-${kill.killmailId}`);
  // Falling, for something lost.
  if (notifyOn(NOTIFY.killsSound)) playTwoTone(587, 440, 'triangle', 0.16);
}

/** Another pilot just marked a connection on the active map end of life. */
export function alertConnectionEol(connectionId: string, timeStatus: string): void {
  if (!anyChannelOn(NOTIFY.eolDesktop, NOTIFY.eolSound)) return;
  const { map } = useMapStore.getState();
  const conn = map.connections.find((c) => c.id === connectionId);
  if (!conn) return;
  const a = map.systems.find((s) => s.id === conn.sourceId);
  const b = map.systems.find((s) => s.id === conn.targetId);
  if (!a || !b) return;

  const t = i18n.t.bind(i18n);
  const body = t(timeStatus === 'lessThan1h' ? 'alerts.eolBody1h' : 'alerts.eolBody4h', {
    a: systemDisplayName(a) || a.name,
    b: systemDisplayName(b) || b.name,
  });
  const title = t('alerts.eolTitle');

  toast.info(body);
  if (notifyOn(NOTIFY.eolDesktop)) fireDesktopNotification(title, body, `nexum-eol-${connectionId}`);
  // Two level notes, like a clock running down.
  if (notifyOn(NOTIFY.eolSound)) playTwoTone(784, 784, 'square', 0.1);
}
