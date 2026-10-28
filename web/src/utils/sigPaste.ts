import type { Signature, SigType } from '../types';
import { GHOST_SUFFIX } from './ghostSites';
import { leadsToFromSigName } from './whDest';

// Reading a probe-scanner paste, and what it may change on a signature that is
// already on the map. Kept out of SignaturePane so the rules can be tested.

const EVE_GROUP_TO_TYPE: Record<string, SigType> = {
  'data site':   'data',
  'gas site':    'gas',
  'relic site':  'relic',
  'combat site': 'combat',
  'ore site':    'ore',
  'wormhole':    'wormhole',
};

export interface ParsedSig { sigId: string; sigType: SigType; name: string; whLeadsTo: string; }

export function parseSigClipboard(text: string): ParsedSig[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line): ParsedSig[] => {
      const parts = line.split('\t');
      const sigId = parts[0]?.trim().toUpperCase() ?? '';
      if (!/^[A-Z]{3}-\d{3}$/.test(sigId)) return [];
      // Skip cosmic anomalies — they live in the Anomalies pane. The scanner's
      // group column ("Cosmic Anomaly" vs "Cosmic Signature") lets a single
      // Ctrl+A/Ctrl+C of the whole window route each row to the right pane.
      // Rows without a group column (partial/manual pastes) still pass through.
      if ((parts[1]?.trim().toLowerCase() ?? '') === 'cosmic anomaly') return [];
      const group = parts[2]?.trim() ?? '';
      const col3 = parts[3]?.trim() ?? '';
      const name = /^\d+\.?\d*%$/.test(col3) ? '' : col3;
      // Ghost sites report as an ordinary site in the scanner's type column —
      // the name is what gives them away ("Superior Blood Raider Covert
      // Research Facility"). Same string the server already uses to log them.
      const sigType: SigType = GHOST_SUFFIX.test(name)
        ? 'ghost'
        : (EVE_GROUP_TO_TYPE[group.toLowerCase()] ?? 'unknown');
      // "Unidentified Wormhole" is a Drifter hole and says so before anyone
      // identifies it. Only for a row we already know is a wormhole — the
      // leads-to cell isn't rendered for other types, so it would be storing a
      // value nobody could see or correct.
      const whLeadsTo = sigType === 'wormhole' ? leadsToFromSigName(name) : '';
      return [{ sigId, sigType, name, whLeadsTo }];
    });
}

/**
 * What a pasted row changes on the signature already holding its scan id.
 *
 * A paste only ever ADDS what the scanner knows. Probe a sig down, mark it a
 * wormhole by hand, then re-paste after a disconnect while the scanner still
 * shows it as a bare "Cosmic Signature": that row reads as type 'unknown' with
 * no name, so it changes nothing, overwrite mode or not. The hole's type,
 * mass and life are never touched, and where it leads is only filled if blank.
 */
export function pasteUpdatesFor(match: Signature, p: ParsedSig): Partial<Signature> {
  const updates: Partial<Signature> = {};
  if (p.sigType !== 'unknown') updates.sigType = p.sigType;
  if (p.name) updates.name = p.name;
  // Fill a blank only — never overwrite a destination someone scouted.
  if (p.whLeadsTo && !match.whLeadsTo) updates.whLeadsTo = p.whLeadsTo;
  return updates;
}
