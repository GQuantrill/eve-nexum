import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useIntelFeed, knownSystem, isClearLine, openDesktopSettings } from '../../desktop/intel';
import type { IntelLine } from '../../desktop/intel';
import { useMapStore } from '../../store/mapStore';
import { useUserSetting } from '../../hooks/useUserSetting';
import { GearIcon } from '../../icons';
import styles from './IntelPane.module.css';

// Desktop app only (the sidebar hides it in a browser): the pilot's intel
// channels as one feed, newest first. Each channel can be switched off;
// "All" switches them all back on. System names are highlighted, and those on
// the open map can be clicked to select them there.

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
  const onMap = useMemo(() => new Map(systems.map((s) => [s.name.toLowerCase(), s.id])), [systems]);

  const isShown = (c: string) => !hidden.has(c.toLowerCase());
  const toggle = (c: string) => setHidden((prev) => {
    const list = Array.isArray(prev) ? prev : [];
    const key = c.toLowerCase();
    return list.includes(key) ? list.filter((x) => x !== key) : [...list, key];
  });
  const shownChannels = channels.filter(isShown);
  const visible = lines.filter((l) => isShown(l.channel)).slice(-SHOW_MAX).reverse();

  const renderText = (line: IntelLine): ReactNode[] =>
    line.text.split(/(\s+)/).map((part, i) => {
      const [, pre, core, post] = WORD.exec(part) ?? ['', '', part, ''];
      const id = onMap.get(core.toLowerCase());
      if (id) {
        return (
          <span key={i}>{pre}
            <button type="button" className={`${styles.sys} ${styles.onMap}`}
              onClick={() => selectSystem(id)}
              data-tooltip={t('intelFeed.selectSystem', { system: core })}>{core}</button>{post}
          </span>
        );
      }
      return knownSystem(core) ? <span key={i}>{pre}<span className={styles.sys}>{core}</span>{post}</span> : part;
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
    </div>
  );
}
