import { describe, it, expect } from 'vitest';
import { settingAllowed } from './auth.js';

// PATCH /auth/settings drops any key not allowed here and still answers 200, so
// a missing key is invisible: the setting simply never leaves the browser that
// set it. That has bitten this codebase twice already (the announcer toggles,
// and the presence filter below), which is why these are pinned.
describe('settings allowlist', () => {
  it('allows the layout settings an org default has to be able to carry', () => {
    for (const k of [
      'nexum.toolbar.order', 'nexum.minimap.position', 'nexum.panelSideBySide',
      'nexum.floatingPanels', 'nexum.sigPane.hiddenCols', 'nexum.anomPane.hiddenCols',
      'nexum.sidebar.order', 'nexum.sig.bookmarkFormat', 'nexum.a11y.colorVision',
    ]) {
      expect(settingAllowed(k), k).toBe(true);
    }
  });

  it('allows the presence flag the server itself reads', () => {
    // routes/character.ts filters the presence list on
    // ui_settings->>'nexum.presence.hidden'. While this key was dropped here the
    // column could only ever read 'false', so "hide me from the map" did nothing.
    expect(settingAllowed('nexum.presence.hidden')).toBe(true);
  });

  it('allows generated keys by prefix, not by enumerating ids that drift', () => {
    // One per panel id and per system-info section. Seven panel ids were listed
    // by hand and every id added since silently stopped syncing.
    expect(settingAllowed('nexum.panel.collapsed.notes')).toBe(true);
    expect(settingAllowed('nexum.panel.collapsed.somethingAddedLater')).toBe(true);
    expect(settingAllowed('nexum.sysinfo.collapse.celestials')).toBe(true);
  });

  it('still refuses anything not asked for', () => {
    // The list is a boundary: arbitrary keys must not reach ui_settings.
    for (const k of ['nexum.notARealSetting', 'notNexum.anything', '', 'nexum.']) {
      expect(settingAllowed(k), k).toBe(false);
    }
  });

  it('keeps per-device state out of the cross-device store', () => {
    // These are deliberately local: a poll cache, pixel sizes that would be
    // wrong on another screen, one-shot prompts, and session scratch.
    for (const k of [
      'nexum.xpoll./api/storms', 'nexum.sidebar.width', 'nexum.panelHeight',
      'nexum.notesEditorHeight', 'nexum.seenMapHint', 'nexum.lastMapId',
      'nexum.last_character', 'nexum.lang',
    ]) {
      expect(settingAllowed(k), k).toBe(false);
    }
  });
});
