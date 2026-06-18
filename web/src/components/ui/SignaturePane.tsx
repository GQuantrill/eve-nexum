import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { useMapStore } from '../../store/mapStore';
import { useCanEditContent } from '../../hooks/useCanEditContent';
import { useShareMode } from '../../context/ShareModeContext';
import { useUserSetting } from '../../hooks/useUserSetting';
import type { Signature, SigType } from '../../types';
import { ConfirmModal, shouldSkipConfirm } from './ConfirmModal';
import { NotesEditor } from './NotesEditor';
import { WormholeTypePicker } from './WormholeTypePicker';
import { XIcon, CopyIcon } from '@phosphor-icons/react';
import { LeadsToDropdown } from './LeadsToDropdown';
import { toast } from './Toaster';
import { reevaluateConnectionsForSystem } from '../../utils/whAutoDetect';
import { alertInboundK162 } from '../../utils/k162Alert';
import { WORMHOLE_TYPES } from '../../data/wormholes';
import { formatBookmarkName, DEFAULT_BOOKMARK_FORMAT } from '../../utils/signatureBookmark';
import { useWormholeTypes } from '../../hooks/useWormholeTypes';
import { duration, DASH } from '../../i18n/format';

// Aging bands for wormhole signatures, anchored to the WH type's known
// lifetime. K162 and unknown codes return '' (no tint) since we don't
// know the real lifetime from this side. Other sig types are skipped.
//
//   < 50% of lifetime → fresh, no tint
//   50–90%            → mid (yellow row)
//   90–100%           → near EOL (orange)
//   > 100%            → past expected lifetime (red — likely closed)
function whAgeRowClass(
  sigType: string,
  whType: string,
  createdAt: string | undefined,
  now: number,
): string {
  if (sigType !== 'wormhole' || !whType || !createdAt) return '';
  const wh = WORMHOLE_TYPES[whType.toUpperCase()];
  if (!wh || wh.lifetimeH <= 0) return '';
  const ageH = (now - new Date(createdAt).getTime()) / 3_600_000;
  const pct  = ageH / wh.lifetimeH;
  if (pct < 0.5)  return '';
  if (pct < 0.9)  return 'sig-row--wh-mid';
  if (pct < 1.0)  return 'sig-row--wh-eol';
  return 'sig-row--wh-past';
}

// Threshold (hours) past which any signature's age cell goes red. Flat
// "you scanned this three days ago, it's probably gone" heuristic applied
// uniformly — wormholes included, regardless of TTL.
const STALE_AGE_HOURS = 72;

function isSigStale(
  _sigType: string,
  _whType: string,
  createdAt: string | undefined,
  now: number,
): boolean {
  if (!createdAt) return false;
  const ageH = (now - new Date(createdAt).getTime()) / 3_600_000;
  return ageH >= STALE_AGE_HOURS;
}

const SIG_TYPE_LABELS: Record<SigType, string> = {
  unknown:  'Unknown',
  wormhole: 'Wormhole',
  data:     'Data',
  relic:    'Relic',
  combat:   'Combat',
  gas:      'Gas',
  ore:      'Ore',
};

const EVE_GROUP_TO_TYPE: Record<string, SigType> = {
  'data site':   'data',
  'gas site':    'gas',
  'relic site':  'relic',
  'combat site': 'combat',
  'ore site':    'ore',
  'wormhole':    'wormhole',
};

interface ParsedSig { sigId: string; sigType: SigType; name: string; }

function parseSigClipboard(text: string): ParsedSig[] {
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
      const sigType = EVE_GROUP_TO_TYPE[group.toLowerCase()] ?? 'unknown';
      const col3 = parts[3]?.trim() ?? '';
      const name = /^\d+\.?\d*%$/.test(col3) ? '' : col3;
      return [{ sigId, sigType, name }];
    });
}

type SortCol = 'sigId' | 'sigType' | 'whType' | 'whLeadsTo' | 'name' | 'createdAt' | 'updatedAt';
type ColKey  = 'id' | 'type' | 'whtype' | 'leadsto' | 'name' | 'notes' | 'created' | 'updated';

const DEFAULT_WIDTHS: Record<ColKey, number> = {
  id:      72,
  type:    108,
  whtype:  170,
  leadsto: 105,
  name:    140,
  notes:   220,
  created: 80,
  updated: 80,
};

// Grace-period choices (seconds) offered before an overwrite-paste actually
// deletes a despawned sig. 0 = delete immediately. Compact s/m labels read
// fine across locales; only "Instant" is translated.
const OVERWRITE_DELAY_OPTIONS = [0, 5, 10, 30, 60, 120] as const;
const OVERWRITE_DELAY_DEFAULT = 10;
function formatDelay(sec: number): string {
  return sec >= 60 ? `${sec / 60}m` : `${sec}s`;
}

// Order the type-filter chips most-useful-first. Covers every SigType.
const SIG_TYPE_FILTER_ORDER: SigType[] = ['wormhole', 'data', 'relic', 'gas', 'ore', 'combat', 'unknown'];

// Signature-type <select> options, alphabetical by label. Used for both the
// per-row type picker and the bulk "set type" dropdown.
const SIG_TYPE_OPTIONS: SigType[] = ['combat', 'data', 'gas', 'ore', 'relic', 'unknown', 'wormhole'];

// Single module-level 1 s tick shared across every ElapsedCell instance.
// Previously each SignaturePane drove a state update every second, which
// re-rendered every row including its embedded MDEditor — extremely expensive.
let tickNow = Date.now();
const tickSubs = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;

function startTickIfNeeded() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    tickNow = Date.now();
    tickSubs.forEach((fn) => fn());
  }, 1000);
}

function ElapsedCell({ iso, className }: { iso: string | undefined; className?: string }) {
  const { t } = useTranslation();
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    tickSubs.add(fn);
    startTickIfNeeded();
    return () => {
      tickSubs.delete(fn);
      if (tickSubs.size === 0 && tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    };
  }, []);
  const text = iso
    ? duration(t, Math.floor((tickNow - new Date(iso).getTime()) / 1000))
    : DASH;
  return <td className={className}>{text}</td>;
}

export function SignaturePane({ systemId }: { systemId: string }) {
  const { t } = useTranslation();
  const sigTypeLabel = (type: SigType) =>
    type === 'unknown' ? t('sigType.unknown') : SIG_TYPE_LABELS[type];
  const activeMapId     = useMapStore((s) => s.activeMapId);
  const map             = useMapStore((s) => s.map);
  const currentSystemId = useMapStore((s) => s.currentSystemId);
  const setSystemSigTypes = useMapStore((s) => s.setSystemSigTypes);
  const canEdit         = useCanEditContent();

  const systemStatics = useMemo(
    () => map.systems.find((sys) => sys.id === systemId)?.statics ?? [],
    [map.systems, systemId],
  );

  const connectedSystems = useMemo(() => {
    const conns = map.connections.filter(
      (c) => c.sourceId === systemId || c.targetId === systemId,
    );
    return conns.flatMap((c) => {
      const otherId = c.sourceId === systemId ? c.targetId : c.sourceId;
      const sys = map.systems.find((m) => m.id === otherId);
      return sys ? [{ id: sys.id, name: sys.name, systemClass: sys.systemClass }] : [];
    });
  }, [map.connections, map.systems, systemId]);

  const [sigs, setSigs]               = useState<Signature[]>([]);
  const [selected, setSelected]       = useState<Set<string>>(new Set());
  const [pendingAction, setPendingAction] = useState<{ message: string; fn: () => void; confirmLabel?: string; showDontAskAgain?: boolean } | null>(null);
  // Default sort is by Sig ID ascending so freshly-pasted rows slot into
  // alphabetical position. User clicks on column headers override this.
  const [sortCol, setSortCol]         = useState<SortCol | null>('sigId');
  const [sortDir, setSortDir]         = useState<'asc' | 'desc'>('asc');
  // Multi-select type filter. Empty = show all; otherwise show only the
  // selected sig types. A view-only filter, so it isn't persisted.
  const [typeFilter, setTypeFilter]   = useState<Set<SigType>>(new Set());

  const toggleTypeFilter = (type: SigType) => {
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };
  // Persist column widths so a user-tuned layout follows them from one
  // system to the next (and across reloads). Stored under a single
  // ui_settings key — drag-resize re-saves on every mousemove tick, but
  // useUserSetting debounces the server PATCH by 500ms so the burst
  // collapses to one round-trip.
  const [savedColWidths, setColWidths] = useUserSetting<Partial<Record<ColKey, number>>>(
    'nexum.sigPane.colWidths',
    {},
  );
  // Merge with defaults at read time so a later-added column gracefully
  // picks up its default width without invalidating the saved layout.
  const colWidths = useMemo(
    () => ({ ...DEFAULT_WIDTHS, ...savedColWidths }) as Record<ColKey, number>,
    [savedColWidths],
  );

  const pendingUpdates = useRef<Map<string, Partial<Signature>>>(new Map());
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const sigsRef        = useRef<Signature[]>([]);
  useEffect(() => { sigsRef.current = sigs; }, [sigs]);

  // Feed this system's scanned wormhole-sig types into the map-wide index so the
  // watchlist can match them live — the user's own edits don't bump sigRev, so
  // the bulk loader wouldn't otherwise see them until a reload.
  useEffect(() => {
    setSystemSigTypes(systemId, sigs.filter((s) => s.whType).map((s) => s.whType.toUpperCase()));
  }, [sigs, systemId, setSystemSigTypes]);

  // Overwrite-on-paste mode. When on (or when Shift is held during a paste),
  // a paste also deletes signatures whose ID is absent from the pasted scan —
  // for re-scanning a system after sites have despawned. Off by default so the
  // long-standing additive behaviour is preserved.
  const [overwriteOnPaste, setOverwriteOnPaste] = useUserSetting<boolean>(
    'nexum.sigPane.overwriteOnPaste',
    false,
  );
  // Shift is tracked in a ref because the `paste` ClipboardEvent carries no
  // modifier state, so Shift+Ctrl+V is detected via this.
  const shiftHeldRef = useRef(false);

  // Grace period (seconds) before an overwrite-paste actually deletes a
  // despawned sig. During it the row stays visible with a "being removed"
  // indicator so the user can note it / clear in-game bookmarks. 0 = instant.
  const [overwriteDelay, setOverwriteDelay] = useUserSetting<number>(
    'nexum.sigPane.overwriteDelay',
    OVERWRITE_DELAY_DEFAULT,
  );
  // Token format for the per-row "copy bookmark name" button. Edited in the
  // sidebar's Map Options; read here to build the pasted name.
  const [bookmarkFormat] = useUserSetting<string>('nexum.sig.bookmarkFormat', DEFAULT_BOOKMARK_FORMAT);
  // Full wormhole catalog — needed so size/mass tokens resolve for every WH
  // type (the static map only covers k-space statics).
  const whTypes = useWormholeTypes();

  const copyBookmark = useCallback((sig: Signature) => {
    const name = formatBookmarkName(bookmarkFormat, sig, whTypes);
    if (!name) return;
    navigator.clipboard.writeText(name)
      .then(() => toast.success(t('signatures.bookmarkCopied', { name })))
      .catch(() => toast.error(t('signatures.bookmarkCopyFailed')));
  }, [bookmarkFormat, whTypes, t]);

  // Sigs currently shown with the pending-removal indicator, plus the timers
  // that delete them once the grace period elapses.
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const removalTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Clear any outstanding removal timers when the pane unmounts.
  useEffect(() => () => {
    for (const tm of removalTimers.current.values()) clearTimeout(tm);
    removalTimers.current.clear();
  }, []);

  // Track whether Shift is physically held — the `paste` ClipboardEvent itself
  // carries no modifier state, so Shift+Ctrl+V is detected via this ref.
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => { if (e.key === 'Shift') shiftHeldRef.current = true; };
    const onUp   = (e: KeyboardEvent) => { if (e.key === 'Shift') shiftHeldRef.current = false; };
    const reset  = () => { shiftHeldRef.current = false; };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', reset);
    };
  }, []);

  const { isShareMode } = useShareMode();
  // Bumped when another client changes this system's sigs (live sync).
  const sigRev = useMapStore((s) => s.sigRev[systemId] ?? 0);

  useEffect(() => {
    if (!activeMapId) return;
    // Cancel any pending overwrite-removals carried over from the previous
    // system — their timers reference rows that are about to be cleared.
    for (const tm of removalTimers.current.values()) clearTimeout(tm);
    removalTimers.current.clear();
    setRemoving(new Set());
    setSigs([]);
    setSelected(new Set());

    // Share viewers have the sigs already embedded in the per-system store
    // payload (SharedMapView populates them on hydrate). The /api/maps/...
    // route would 22P02-crash on the placeholder "shared" mapId and isn't
    // exposed via optionalAuth anyway, so skip the fetch entirely.
    if (isShareMode) {
      const sys = useMapStore.getState().map.systems.find((s) => s.id === systemId);
      const embedded = (sys as { signatures?: Signature[] } | undefined)?.signatures ?? [];
      setSigs(embedded);
      return;
    }

    api<Signature[]>(`/api/maps/${activeMapId}/systems/${systemId}/signatures`)
      .then(setSigs)
      .catch(() => toast.error(t('signatures.loadFailed')));
  }, [activeMapId, systemId, isShareMode]);

  // Live sync: when a remote client changes this system's sigs, re-fetch in
  // place (no clear/flicker, keeps selection). Guarded so it doesn't fire on
  // the initial mount (rev starts at 0).
  useEffect(() => {
    if (!activeMapId || isShareMode || sigRev === 0) return;
    api<Signature[]>(`/api/maps/${activeMapId}/systems/${systemId}/signatures`)
      .then(setSigs)
      .catch(() => {});
  }, [sigRev, activeMapId, systemId, isShareMode]);

  const updateSig = (id: string, updates: Partial<Signature>) => {
    const existing = sigsRef.current.find((s) => s.id === id);
    const withTs = { ...updates, updatedAt: new Date().toISOString() };
    setSigs((prev) => prev.map((s) => s.id === id ? { ...s, ...withTs } : s));

    // Inbound K162 alert: fire once when a sig's whType transitions INTO K162
    // (anything else, including blank, → K162). Strong intel signal that
    // something just connected to this system from outside the chain.
    if (
      'whType' in updates &&
      updates.whType?.toUpperCase() === 'K162' &&
      existing?.whType?.toUpperCase() !== 'K162'
    ) {
      const sysName = map.systems.find((s) => s.id === systemId)?.name ?? 'unknown system';
      alertInboundK162(sysName);
    }

    // Re-evaluate connections whenever whType or whLeadsTo changes — either
    // to fill / upgrade the connection, or to clear it if this edit removed
    // the only backing sig.
    if ('whType' in updates || 'whLeadsTo' in updates) {
      const nextSigs = sigsRef.current.map((s) => (s.id === id ? { ...s, ...updates } : s));
      reevaluateConnectionsForSystem(systemId, nextSigs, existing);
    }

    pendingUpdates.current.set(id, { ...(pendingUpdates.current.get(id) ?? {}), ...updates });
    clearTimeout(debounceTimers.current.get(id));
    debounceTimers.current.set(id, setTimeout(async () => {
      const payload = pendingUpdates.current.get(id);
      if (!payload || !activeMapId) return;
      pendingUpdates.current.delete(id);
      api(`/api/maps/${activeMapId}/systems/${systemId}/signatures/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }).catch(() => toast.error(t('signatures.saveFailed')));
    }, 500));
  };

  // Annotate K162 (return-side) wormhole sigs with the real source type. The
  // scanned sig on this side only ever reads "K162"; the shared connection,
  // however, has already resolved to the originating code (e.g. B449) via
  // whAutoDetect. Drop that into the sig's notes so the source hole is visible
  // from the K162 system without clicking the connection line. Only fills an
  // empty notes field (never clobbers a user-typed one) and matches the sig to
  // its connection by leads-to, so a system with several holes fills the right
  // row.
  useEffect(() => {
    if (!canEdit || isShareMode) return;
    for (const sig of sigs) {
      if (sig.notes) continue;
      if (sig.sigType !== 'wormhole') continue;
      if (sig.whType?.toUpperCase() !== 'K162') continue;
      const leads = sig.whLeadsTo?.toUpperCase();
      if (!leads) continue;
      let source: string | null = null;
      for (const conn of map.connections) {
        if (conn.connectionType !== 'standard') continue;
        const otherId =
          conn.sourceId === systemId ? conn.targetId :
          conn.targetId === systemId ? conn.sourceId : null;
        if (!otherId) continue;
        const other = map.systems.find((s) => s.id === otherId);
        if (!other) continue;
        const oc = other.systemClass.toUpperCase();
        const on = (other.name ?? '').toUpperCase();
        if (leads !== oc && leads !== on) continue;
        const t = conn.type?.toUpperCase();
        if (t && t !== 'K162') { source = conn.type; break; }
      }
      if (source) updateSig(sig.id, { notes: source });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigs, map.connections, map.systems, systemId, canEdit, isShareMode]);

  // Drop any pending overwrite-removal timer/indicator for this id (the row is
  // being deleted now, whether by the timer firing or a manual delete).
  const clearRemoval = (id: string) => {
    const tm = removalTimers.current.get(id);
    if (tm) { clearTimeout(tm); removalTimers.current.delete(id); }
    setRemoving((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev); next.delete(id); return next;
    });
  };

  const deleteSig = (id: string) => {
    if (!activeMapId) return;
    clearRemoval(id);
    const deleted = sigsRef.current.find((s) => s.id === id);
    setSigs((prev) => prev.filter((s) => s.id !== id));
    setSelected((prev) => { const next = new Set(prev); next.delete(id); return next; });

    // If the deleted sig was backing a connection, quarantine it — the hole
    // collapsed, so the connection is severed (broken) but kept on the map.
    if (deleted && deleted.whType && deleted.whLeadsTo) {
      const nextSigs = sigsRef.current.filter((s) => s.id !== id);
      reevaluateConnectionsForSystem(systemId, nextSigs, deleted, true);
    }

    api(`/api/maps/${activeMapId}/systems/${systemId}/signatures/${id}`, { method: 'DELETE' })
      .catch(() => toast.error(t('signatures.deleteFailed')));
  };

  // Mark a despawned sig for removal after `delaySec`, keeping it visible with
  // the indicator meanwhile. delaySec <= 0 deletes immediately. Reschedules
  // cleanly if the sig was already pending.
  const scheduleRemoval = (id: string, delaySec: number) => {
    const existing = removalTimers.current.get(id);
    if (existing) clearTimeout(existing);
    if (delaySec <= 0) {
      removalTimers.current.delete(id);
      deleteSig(id);
      return;
    }
    setRemoving((prev) => { const next = new Set(prev); next.add(id); return next; });
    const tm = setTimeout(() => deleteSig(id), delaySec * 1000);
    removalTimers.current.set(id, tm);
  };

  const processPaste = useCallback(async (parsed: ParsedSig[], overwrite: boolean, delaySec: number) => {
    if (!activeMapId) return;
    const existing = sigsRef.current;
    const toUpdate: { id: string; updates: Partial<Signature> }[] = [];
    const toCreate: ParsedSig[] = [];

    for (const p of parsed) {
      const match = existing.find((s) => s.sigId === p.sigId);
      if (match) {
        const updates: Partial<Signature> = {};
        if (p.sigType !== 'unknown') updates.sigType = p.sigType;
        if (p.name) updates.name = p.name;
        toUpdate.push({ id: match.id, updates });
      } else {
        toCreate.push(p);
      }
    }

    // In overwrite mode, remove scanned sigs that are no longer in the paste
    // (despawned since the last scan). Rather than deleting outright they're
    // flagged for removal and deleted after `delaySec`, so the user gets a
    // visible indicator and time to clear in-game bookmarks. A sig that
    // reappears in this paste has any pending removal cancelled. Rows still
    // present keep their age, type, and connection links; blank/manually-added
    // rows (no sig ID) are left alone. Default (additive) mode is untouched.
    if (overwrite) {
      const pastedIds = new Set(parsed.map((p) => p.sigId));
      for (const s of existing) {
        if (!s.sigId) continue;
        if (pastedIds.has(s.sigId)) clearRemoval(s.id);
        else scheduleRemoval(s.id, delaySec);
      }
    }

    for (const { id, updates } of toUpdate) updateSig(id, updates);

    // Fire all creates in parallel, gather the successes, then do ONE setSigs
    // that includes the new rows and re-sorts. The previous version sorted
    // before the per-sig setSigs callbacks had flushed, so newly-created
    // entries weren't being sorted at all.
    const created = (await Promise.all(
      toCreate.map((p) =>
        api<Signature>(
          `/api/maps/${activeMapId}/systems/${systemId}/signatures`,
          { method: 'POST', body: JSON.stringify({ sigId: p.sigId, sigType: p.sigType, name: p.name }) },
        ).catch(() => null),
      ),
    )).filter((s): s is Signature => s !== null);

    setSigs((prev) => [...prev, ...created].sort((a, b) => a.sigId.localeCompare(b.sigId)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMapId, systemId]);

  useEffect(() => {
    if (!activeMapId) return;

    const handlePaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) return;

      const text = e.clipboardData?.getData('text') ?? '';
      const parsed = parseSigClipboard(text);
      if (parsed.length === 0) return;

      e.preventDefault();

      // Overwrite when the mode is toggled on OR Shift is held for this paste.
      const overwrite = overwriteOnPaste || shiftHeldRef.current;
      const delaySec = overwriteDelay;

      // Warn if the character is in a different system than the one being edited
      if (currentSystemId && currentSystemId !== systemId) {
        const currentName  = map.systems.find((s) => s.id === currentSystemId)?.name  ?? 'unknown';
        const selectedName = map.systems.find((s) => s.id === systemId)?.name ?? 'unknown';
        setPendingAction({
          message: t('signatures.pasteDifferentSystem', { current: currentName, selected: selectedName }),
          fn: () => processPaste(parsed, overwrite, delaySec),
          confirmLabel: t('actions.ok'),
          showDontAskAgain: false,
        });
        return;
      }

      processPaste(parsed, overwrite, delaySec);
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [activeMapId, systemId, currentSystemId, map.systems, processPaste, overwriteOnPaste, overwriteDelay, t]);

  const addSig = async () => {
    if (!activeMapId) return;
    const sig = await api<Signature>(
      `/api/maps/${activeMapId}/systems/${systemId}/signatures`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    setSigs((prev) => [...prev, sig]);
  };

  const confirm = (message: string, action: () => void) => {
    if (shouldSkipConfirm()) { action(); return; }
    setPendingAction({ message, fn: action });
  };

  const deleteSelected = () => confirm(
    t('signatures.deleteSelectedConfirm', { count: selected.size }),
    () => { for (const id of selected) deleteSig(id); },
  );

  // Bulk-assign a sig type to every selected row.
  const setSelectedType = (type: SigType) => {
    for (const id of selected) updateSig(id, { sigType: type });
  };

  const deleteAll = () => confirm(
    t('signatures.deleteAllConfirm', { count: sigsRef.current.length }),
    () => { for (const sig of sigsRef.current) deleteSig(sig.id); },
  );

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allChecked = sigs.length > 0 && selected.size === sigs.length;
  const someChecked = selected.size > 0 && !allChecked;
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(sigs.map((s) => s.id)));

  const handleSort = (col: SortCol) => {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  };

  const sortedSigs = useMemo(() => {
    const base = typeFilter.size ? sigs.filter((s) => typeFilter.has(s.sigType)) : sigs;
    if (!sortCol) return base;
    return [...base].sort((a, b) => {
      const av = (a[sortCol] ?? '').toLowerCase();
      const bv = (b[sortCol] ?? '').toLowerCase();
      const cmp = av.localeCompare(bv);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [sigs, sortCol, sortDir, typeFilter]);

  const startResize = (col: ColKey, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = colWidths[col];
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      const newWidth = Math.max(40, startWidth + ev.clientX - startX);
      setColWidths((prev) => ({ ...prev, [col]: newWidth }));
    };

    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const sortInd = (col: SortCol) =>
    sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <>
    {pendingAction && (
      <ConfirmModal
        message={pendingAction.message}
        onConfirm={() => { pendingAction.fn(); setPendingAction(null); }}
        onCancel={() => setPendingAction(null)}
        confirmLabel={pendingAction.confirmLabel}
        showDontAskAgain={pendingAction.showDontAskAgain}
      />
    )}
    <div className="sig-pane">
      {!isShareMode && sigs.length === 0 && (
        <p className="sig-pane__hint">{t('signatures.pasteHint')}</p>
      )}
      {canEdit && !isShareMode && (
        <div className="sig-pane__toolbar">
          <button className="icon-btn" onClick={addSig} title={t('signatures.addSignature')}>{t('signatures.addSignature')}</button>
          <label
            className={`sig-overwrite-toggle${overwriteOnPaste ? ' sig-overwrite-toggle--active' : ''}`}
            data-tooltip={t('signatures.overwriteTooltip')}
          >
            <input
              type="checkbox"
              className="map-sidebar__toggle-input"
              checked={overwriteOnPaste}
              onChange={(e) => setOverwriteOnPaste(e.target.checked)}
            />
            <span>{t('signatures.overwriteToggle')}</span>
          </label>
          <select
            className="sig-toolbar-btn"
            value={overwriteDelay}
            onChange={(e) => setOverwriteDelay(Number(e.target.value))}
            aria-label={t('signatures.removeDelayLabel')}
            data-tooltip={t('signatures.removeDelayTooltip')}
          >
            {OVERWRITE_DELAY_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s === 0 ? t('signatures.removeDelayInstant') : formatDelay(s)}
              </option>
            ))}
          </select>
          {selected.size > 0 && (
            <>
              <select
                className="sig-toolbar-btn"
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  setSelectedType(e.target.value as SigType);
                  e.target.value = '';
                }}
                aria-label={t('signatures.setTypeAria')}
              >
                <option value="">{t('signatures.setType', { count: selected.size })}</option>
                {SIG_TYPE_OPTIONS.map((type) => (
                  <option key={type} value={type}>{t(`sigType.${type}`)}</option>
                ))}
              </select>
              <button className="sig-toolbar-btn sig-toolbar-btn--danger" onClick={deleteSelected}>
                {t('signatures.deleteSelected', { count: selected.size })}
              </button>
            </>
          )}
          {sigs.length > 0 && (
            <button className="sig-toolbar-btn sig-toolbar-btn--danger" onClick={deleteAll}>
              {t('signatures.deleteAll')}
            </button>
          )}
        </div>
      )}

      {sigs.length > 0 && (
        <div className="sig-pane__filter" role="group" aria-label={t('signatures.filterLabel')}>
          {SIG_TYPE_FILTER_ORDER.map((type) => (
            <button
              key={type}
              type="button"
              className={`sig-filter-chip sig-filter-chip--${type}${typeFilter.has(type) ? ' sig-filter-chip--active' : ''}`}
              aria-pressed={typeFilter.has(type)}
              onClick={() => toggleTypeFilter(type)}
            >
              {t(`sigType.${type}`)}
            </button>
          ))}
          {typeFilter.size > 0 && (
            <button type="button" className="sig-filter-clear" onClick={() => setTypeFilter(new Set())}>
              {t('signatures.filterClear')}
            </button>
          )}
        </div>
      )}

      {sigs.length === 0 ? (
        <div className={`sig-pane__empty${isShareMode ? ' sig-pane__empty--shared' : ''}`}>
          {isShareMode ? t('signatures.emptyShared') : t('signatures.empty')}
        </div>
      ) : sortedSigs.length === 0 ? (
        <div className="sig-pane__empty">{t('signatures.noMatchFilter')}</div>
      ) : (
        <div className="sig-table-wrap">
        <table className="sig-table">
          <colgroup>
            {/* In share mode the checkbox and per-row delete cells are
                gone, so their <col> entries must drop too — otherwise
                table-layout:fixed maps them onto the wrong cells and
                the ID column inherits the 24px checkbox width. */}
            {!isShareMode && <col className="sig-col--check" />}
            <col style={{ width: colWidths.id }} />
            <col style={{ width: colWidths.type }} />
            <col style={{ width: colWidths.whtype }} className="sig-col--whtype" />
            <col style={{ width: colWidths.leadsto }} />
            <col style={{ width: colWidths.name }} />
            <col style={{ width: colWidths.notes }} />
            <col style={{ width: colWidths.created }} />
            <col style={{ width: colWidths.updated }} />
            {!isShareMode && <col className="sig-col--actions" />}
          </colgroup>
          <thead>
            <tr>
              {!isShareMode && (
                <th>
                  <input
                    type="checkbox"
                    className="sig-checkbox"
                    checked={allChecked}
                    ref={(el) => { if (el) el.indeterminate = someChecked; }}
                    onChange={toggleAll}
                  />
                </th>
              )}
              <th className="sig-th sig-th--sortable" onClick={() => handleSort('sigId')}>
                {t('signatures.colId')}{sortInd('sigId')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('id', e)} />
              </th>
              <th className="sig-th sig-th--sortable" onClick={() => handleSort('sigType')}>
                {t('signatures.colType')}{sortInd('sigType')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('type', e)} />
              </th>
              <th className="sig-th sig-th--sortable" onClick={() => handleSort('whType')}>
                {t('signatures.colWh')}{sortInd('whType')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('whtype', e)} />
              </th>
              <th className="sig-th sig-th--sortable" onClick={() => handleSort('whLeadsTo')}>
                {t('signatures.colLeadsTo')}{sortInd('whLeadsTo')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('leadsto', e)} />
              </th>
              <th className="sig-th sig-th--sortable" onClick={() => handleSort('name')}>
                {t('signatures.colName')}{sortInd('name')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('name', e)} />
              </th>
              <th className="sig-th">
                {t('signatures.colNotes')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('notes', e)} />
              </th>
              <th className="sig-th sig-th--sortable sig-th--time" onClick={() => handleSort('createdAt')}>
                {t('signatures.colAge')}{sortInd('createdAt')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('created', e)} />
              </th>
              <th className="sig-th sig-th--sortable sig-th--time" onClick={() => handleSort('updatedAt')}>
                {t('signatures.colUpdated')}{sortInd('updatedAt')}
                <div className="sig-th__resize" onMouseDown={(e) => startResize('updated', e)} />
              </th>
              {!isShareMode && <th className="sig-cell--actions" />}
            </tr>
          </thead>
          <tbody>
            {sortedSigs.map((sig) => (
              <tr
                key={sig.id}
                className={`${selected.has(sig.id) ? 'sig-row--selected' : ''} ${sig.sigType === 'unknown' ? 'sig-row--unknown' : ''} ${whAgeRowClass(sig.sigType, sig.whType, sig.createdAt, tickNow)} ${removing.has(sig.id) ? 'sig-row--removing' : ''}`}
                style={removing.has(sig.id) && overwriteDelay > 0 ? { animationDuration: `${overwriteDelay}s` } : undefined}
              >
                {!isShareMode && (
                  <td>
                    <input
                      type="checkbox"
                      className="sig-checkbox"
                      checked={selected.has(sig.id)}
                      onChange={() => toggleSelect(sig.id)}
                    />
                  </td>
                )}
                <td>
                  {isShareMode ? (
                    <span className="sig-text sig-text--id">{sig.sigId}</span>
                  ) : (
                    <input
                      className="sig-input sig-input--id"
                      value={sig.sigId}
                      onChange={(e) => updateSig(sig.id, { sigId: e.target.value.toUpperCase() })}
                      placeholder="ABC-123"
                      maxLength={7}
                      spellCheck={false}
                    />
                  )}
                </td>
                <td>
                  {isShareMode ? (
                    <span className={`sig-text sig-text--type sig-select--type-${sig.sigType}`}>
                      {sigTypeLabel(sig.sigType)}
                    </span>
                  ) : (
                    <select
                      className={`sig-select sig-select--type sig-select--type-${sig.sigType}`}
                      value={sig.sigType}
                      onChange={(e) => updateSig(sig.id, { sigType: e.target.value as SigType })}
                    >
                      {SIG_TYPE_OPTIONS.map((st) => (
                        <option key={st} value={st}>{sigTypeLabel(st)}</option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="sig-td--wh">
                  {sig.sigType === 'wormhole' && (
                    isShareMode
                      ? <span className="sig-text">{sig.whType || ''}</span>
                      : <WormholeTypePicker
                          value={sig.whType}
                          statics={systemStatics}
                          onChange={(whType, leadsTo) => updateSig(sig.id, {
                            whType,
                            ...(!sig.whLeadsTo && leadsTo ? { whLeadsTo: leadsTo } : {}),
                          })}
                        />
                  )}
                </td>
                <td className="sig-td--wh">
                  {sig.sigType === 'wormhole' && (
                    isShareMode
                      ? <span className="sig-text">{sig.whLeadsTo || ''}</span>
                      : <LeadsToDropdown
                          value={sig.whLeadsTo}
                          connectedSystems={connectedSystems}
                          onChange={(leadsTo) => updateSig(sig.id, { whLeadsTo: leadsTo })}
                        />
                  )}
                </td>
                <td>
                  {isShareMode ? (
                    <span className="sig-text">{sig.name}</span>
                  ) : (
                    <input
                      className="sig-input"
                      value={sig.name}
                      onChange={(e) => updateSig(sig.id, { name: e.target.value })}
                      placeholder={t('signatures.namePlaceholder')}
                    />
                  )}
                </td>
                <td className="sig-notes-cell">
                  <NotesEditor
                    value={sig.notes}
                    onChange={(v) => updateSig(sig.id, { notes: v })}
                    compact
                    readOnly={!canEdit || isShareMode}
                  />
                </td>
                <ElapsedCell
                  iso={sig.createdAt}
                  className={`sig-td--time${
                    isSigStale(sig.sigType, sig.whType, sig.createdAt, tickNow)
                      ? ' sig-td--age-stale'
                      : ''
                  }`}
                />
                <ElapsedCell iso={sig.updatedAt} className="sig-td--time sig-td--updated" />
                {!isShareMode && (
                  <td className="sig-cell--actions">
                    {sig.sigType === 'wormhole' && (
                      <button
                        className="icon-btn"
                        onClick={() => copyBookmark(sig)}
                        title={t('signatures.copyBookmark')}
                      ><CopyIcon size={12} weight="bold" /></button>
                    )}
                    {canEdit && (
                      <button
                        className="icon-btn icon-btn--danger"
                        onClick={() => deleteSig(sig.id)}
                        title={t('actions.delete')}
                      ><XIcon size={12} weight="bold" /></button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
    </>
  );
}
