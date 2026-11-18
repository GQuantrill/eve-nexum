import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useIntelFeed, knownSystem, isClearLine, openDesktopSettings } from '../../desktop/intel';
import type { IntelLine } from '../../desktop/intel';
import { useMapStore } from '../../store/mapStore';
import { useUserSetting } from '../../hooks/useUserSetting';
import { GearIcon, MapPinSimpleIcon, PathIcon } from '../../icons';
import { ContextMenu } from './ContextMenu';
import { setWaypoint, KSPACE_CLASSES } from '../../utils/routeActions';
import type { MapSystem } from '../../types';
import { useRoute } from '../../hooks/useRoute';
import { useRouteOrigin } from '../../hooks/useRouteOrigin';
import { jumps as jumpsLabel } from '../../i18n/format';
import styles from './IntelPane.module.css';

// Desktop app only (the sidebar hides it in a browser): the pilot's intel
// channels as one feed, newest first. Each channel can be switched off;
// "All" switches them all back on. System names are highlighted, and those on
// the open map can be clicked to select them there, or right-clicked to set
// them as the autopilot destination or add them as a waypoint.

const HIDDEN_KEY = 'nexum.intel.feedHidden';
const SHOW_MAX = 100;
const WORD = /^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9]*)$/;

const eveTime = (at: number): string => new Date(at).toISOString().slice(11, 19);

export function IntelPane() {
  const { t } = useTranslation();
  const { channels, lines } = useIntelFeed();
  const systems = useMapStore((s) => s.map.systems);
  const selectSystem = useMapStore((s) => s.selectSystem);
  const [hiddenRaw, setHidden] = useUserSetting<string[]>(HIDDEN_KEY, []);
  const hidden = useMemo(() => new Set(Array.isArray(hiddenRaw) ? hiddenRaw : []), [hiddenRaw]);
  const onMap = useMemo(() => new Map(systems.map((s) => [s.name.toLowerCase(), s])), [systems]);
  const [menu, setMenu] = useState<{ x: number; y: number; sys: MapSystem } | null>(null);

  const isShown = (c: string) => !hidden.has(c.toLowerCase());
  const toggle = (c: string) => setHidden((prev) => {
    const list = Array.isArray(prev) ? prev : [];
    const key = c.toLowerCase();
    return list.includes(key) ? list.filter((x) => x !== key) : [...list, key];
  });
  const shownChannels = channels.filter(isShown);
  const visible = lines.filter((l) => isShown(l.channel)).slice(-SHOW_MAX).reverse();

  // How far each system named in the shown lines is from you, so the reports
  // that matter stand out. One route request for all of them.
  const origin = useRouteOrigin();
  const sysIdOf = (word: string): number | null =>
    onMap.get(word.toLowerCase())?.eveSystemId ?? knownSystem(word)?.eveSystemId ?? null;
  // A fresh array each render is fine: useRoute keys on the ids themselves.
  const targetIds = [...new Set(visible.flatMap((l) => l.text.split(/\s+/)
    .map((part) => sysIdOf(WORD.exec(part)?.[2] ?? part))
    .filter((id): id is number => id != null)))].sort((a, b) => a - b);
  const routes = useRoute(origin.systemId, targetIds);
  const distance = (core: string): ReactNode => {
    const id = sysIdOf(core);
    const route = id != null ? routes[id] : undefined;
    return route ? <span className={styles.jumps}>{jumpsLabel(t, route.jumps)}</span> : null;
  };

  const renderText = (line: IntelLine): ReactNode[] =>
    line.text.split(/(\s+)/).map((part, i) => {
      const [, pre, core, post] = WORD.exec(part) ?? ['', '', part, ''];
      const sys = onMap.get(core.toLowerCase());
      if (sys) {
        return (
          <span key={i}>{pre}
            <button type="button" className={`${styles.sys} ${styles.onMap}`}
              onClick={() => selectSystem(sys.id)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, sys }); }}
              data-tooltip={t('intelFeed.selectSystem', { system: core })}>{core}</button>{distance(core)}{post}
          </span>
        );
      }
      return knownSystem(core)
        ? <span key={i}>{pre}<span className={styles.sys}>{core}</span>{distance(core)}{post}</span>
        : part;
    });

  if (channels.length === 0) {
    return (
      <div className={styles.note}>
        <p>{t('intelFeed.noChannels')}</p>
        <button type="button" className="btn btn--ghost" onClick={openDesktopSettings}>{t('intelFeed.settings')}</button>
      </div>
    );
  }

  return (
    <div className={styles.pane}>
      <div className={styles.chips}>
        <button type="button"
          className={`${styles.chip} ${hidden.size === 0 ? styles.chipOn : ''}`}
          aria-pressed={hidden.size === 0}
          onClick={() => setHidden([])}>{t('intelFeed.all')}</button>
        {channels.map((c) => (
          <button key={c} type="button"
            className={`${styles.chip} ${isShown(c) ? styles.chipOn : ''}`}
            aria-pressed={isShown(c)}
            onClick={() => toggle(c)}
            data-tooltip={t(isShown(c) ? 'intelFeed.hide' : 'intelFeed.show', { channel: c })}>{c}</button>
        ))}
        <button type="button" className={`icon-btn ${styles.gear}`} onClick={openDesktopSettings}
          aria-label={t('intelFeed.settings')} data-tooltip={t('intelFeed.settings')}>
          <GearIcon size={13} weight="bold" />
        </button>
      </div>
      {visible.length === 0 ? (
        <p className={styles.note}>{t('intelFeed.empty')}</p>
      ) : (
        <ul className={styles.list}>
          {visible.map((l) => (
            <li key={`${l.channel}|${l.at}|${l.sender}|${l.text}`}
              className={`${styles.line} ${isClearLine(l.text) ? styles.clear : ''}`}>
              <span className={styles.meta}>
                <span className={styles.time}>{eveTime(l.at)}</span>
                {shownChannels.length > 1 && <span className={styles.channel}>{l.channel}</span>}
                <span className={styles.sender}>{l.sender}</span>
              </span>
              <span className={styles.text}>{renderText(l)}</span>
            </li>
          ))}
        </ul>
      )}
      {menu && (() => {
        // Autopilot only routes through k-space: a wormhole system can't be a
        // destination or a waypoint.
        const eveId = menu.sys.eveSystemId;
        const ok = eveId != null && KSPACE_CLASSES.has(menu.sys.systemClass);
        const why = ok ? undefined : t('route.jspaceNoWaypoint');
        return (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={[
              { label: t('waypoint.setDestination'), icon: <MapPinSimpleIcon size={14} />, disabled: !ok, tooltip: why,
                action: () => { if (eveId != null) setWaypoint(eveId, menu.sys.name, true); } },
              { label: t('waypoint.addWaypoint'), icon: <PathIcon size={14} />, disabled: !ok, tooltip: why,
                action: () => { if (eveId != null) setWaypoint(eveId, menu.sys.name, false); } },
            ]}
            onClose={() => setMenu(null)}
          />
        );
      })()}
    </div>
  );
}
