import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUserSetting, readUserSetting } from '../../hooks/useUserSetting';
import {
  THEMES, THEME_KEY, THEME_DEFAULT, CUSTOM_THEMES_KEY, MAX_CUSTOM_THEMES, MAX_THEME_NAME, MAX_BG_LUMINANCE,
  SEED_KEYS, type ThemeSeeds, type CustomTheme,
  parseCustomThemes, normaliseTheme, customThemeValue, newCustomThemeId, seedsOf, applySeeds, applyTheme, luminance,
} from '../../utils/themes';

// Settings > Appearance: the presets, the pilot's own themes, and the editor
// that makes them (four colours, previewed live on the whole app).

function Swatches({ seeds }: { seeds: ThemeSeeds }) {
  return (
    <span className="theme-picker__swatches" aria-hidden="true">
      {SEED_KEYS.map((k) => <span key={k} className="theme-picker__swatch" style={{ background: seeds[k] }} />)}
    </span>
  );
}

interface Draft { id: string | null; name: string; seeds: ThemeSeeds }

export function ThemePicker() {
  const { t } = useTranslation();
  const [theme, setTheme] = useUserSetting<string>(THEME_KEY, THEME_DEFAULT);
  const [stored, setStored] = useUserSetting<unknown>(CUSTOM_THEMES_KEY, []);
  const customs = parseCustomThemes(stored);
  const chosen = normaliseTheme(theme, customs);
  const [draft, setDraft] = useState<Draft | null>(null);

  // Preview the draft on the whole app while it's open; put the saved theme
  // back when it closes (saved or not).
  useEffect(() => {
    if (!draft) return;
    applySeeds(draft.seeds);
  }, [draft]);
  // Settings closed mid-edit: the preview mustn't outlive it.
  useEffect(() => () => applyTheme(
    readUserSetting<string>(THEME_KEY, THEME_DEFAULT),
    parseCustomThemes(readUserSetting<unknown>(CUSTOM_THEMES_KEY, [])),
  ), []);
  const close = () => {
    setDraft(null);
    applyTheme(theme, customs);
  };

  const tooLight = !!draft && luminance(draft.seeds.bg) > MAX_BG_LUMINANCE;
  const save = () => {
    if (!draft || tooLight) return;
    const name = draft.name.trim().slice(0, MAX_THEME_NAME);
    const id = draft.id ?? newCustomThemeId();
    const next: CustomTheme[] = draft.id
      ? customs.map((c) => (c.id === draft.id ? { id, name, seeds: draft.seeds } : c))
      : [...customs, { id, name, seeds: draft.seeds }];
    setStored(next);
    setTheme(customThemeValue(id));
    setDraft(null);
    applyTheme(customThemeValue(id), next);
  };
  const remove = (c: CustomTheme) => {
    const next = customs.filter((x) => x.id !== c.id);
    setStored(next);
    if (chosen === customThemeValue(c.id)) setTheme(THEME_DEFAULT);
  };
  const nameOf = (c: CustomTheme) => c.name || t('mapSidebar.themeEditor.untitled');

  return (
    <div className="map-sidebar__field">
      <span className="map-sidebar__label">{t('mapSidebar.theme')}</span>
      <div className="theme-picker" role="radiogroup" aria-label={t('mapSidebar.theme')}>
        {THEMES.map((th) => (
          <button key={th.id} type="button" role="radio" aria-checked={chosen === th.id}
            className={`theme-picker__row${chosen === th.id ? ' theme-picker__row--on' : ''}`}
            onClick={() => setTheme(th.id)}>
            <Swatches seeds={th.seeds} />
            {t(`mapSidebar.themes.${th.id}`)}
          </button>
        ))}
        {customs.length > 0 && <span className="theme-picker__heading">{t('mapSidebar.themeEditor.custom')}</span>}
        {customs.map((c) => (
          <div key={c.id} className={`theme-picker__row theme-picker__row--custom${chosen === customThemeValue(c.id) ? ' theme-picker__row--on' : ''}`}>
            <button type="button" role="radio" aria-checked={chosen === customThemeValue(c.id)}
              className="theme-picker__pick" onClick={() => setTheme(customThemeValue(c.id))}>
              <Swatches seeds={c.seeds} />
              {nameOf(c)}
            </button>
            <button type="button" className="map-sidebar__zoom-value" onClick={() => setDraft({ id: c.id, name: c.name, seeds: { ...c.seeds } })}>
              {t('mapSidebar.themeEditor.edit')}
            </button>
            <button type="button" className="map-sidebar__zoom-value" onClick={() => remove(c)}>
              {t('mapSidebar.themeEditor.delete')}
            </button>
          </div>
        ))}
      </div>

      {draft ? (
        <div className="theme-editor">
          <div className="map-sidebar__row">
            <label className="map-sidebar__label" htmlFor="theme-name">{t('mapSidebar.themeEditor.name')}</label>
            <input id="theme-name" className="map-sidebar__select" type="text" maxLength={MAX_THEME_NAME}
              value={draft.name} placeholder={t('mapSidebar.themeEditor.untitled')}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          {SEED_KEYS.map((k) => (
            <div key={k} className="map-sidebar__row">
              <label className="map-sidebar__label" htmlFor={`theme-seed-${k}`}>{t(`mapSidebar.themeEditor.seeds.${k}`)}</label>
              <label className="map-sidebar__swatch" style={{ background: draft.seeds[k] }}>
                <input id={`theme-seed-${k}`} type="color" value={draft.seeds[k]}
                  onChange={(e) => setDraft({ ...draft, seeds: { ...draft.seeds, [k]: e.target.value } })} />
              </label>
            </div>
          ))}
          <p className="map-sidebar__help">{t(tooLight ? 'mapSidebar.themeEditor.tooLight' : 'mapSidebar.themeEditor.hint')}</p>
          <div className="theme-editor__actions">
            <button type="button" className="btn btn--ghost" onClick={close}>{t('mapSidebar.themeEditor.cancel')}</button>
            <button type="button" className="btn btn--primary" disabled={tooLight} onClick={save}>{t('mapSidebar.themeEditor.save')}</button>
          </div>
        </div>
      ) : customs.length < MAX_CUSTOM_THEMES ? (
        <button type="button" className="btn btn--ghost theme-picker__create"
          onClick={() => setDraft({ id: null, name: '', seeds: seedsOf(theme, customs) })}>
          {t('mapSidebar.themeEditor.create')}
        </button>
      ) : (
        <p className="map-sidebar__help">{t('mapSidebar.themeEditor.limit', { max: MAX_CUSTOM_THEMES })}</p>
      )}
    </div>
  );
}
