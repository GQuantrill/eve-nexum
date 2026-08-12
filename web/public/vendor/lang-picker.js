// Stylized language dropdown for the static marketing pages (help, compare).
// Mirrors the app's in-React LanguageSwitcher: a custom dropdown (not a native
// <select>) rendering bundled SVG flags — country-flag emoji are absent from the
// Windows emoji font, so a native <select> or emoji would show bare country
// codes there. Flags are served from /vendor/flags/*.svg so they render the same
// on every OS.
//
// Selecting a language persists to the same `nexum.lang` localStorage key the app
// and each page's translation script use, then reloads to re-run the swap. Each
// page sets window.__nexumResolvedLang (the language it actually rendered) before
// this runs, so the picker highlights the matching entry.
(function () {
  'use strict';

  var LANGS = [
    { code: 'en', name: 'English',  flag: 'GB' },
    { code: 'de', name: 'Deutsch',  flag: 'DE' },
    { code: 'fr', name: 'Français', flag: 'FR' },
    { code: 'es', name: 'Español',  flag: 'ES' },
    { code: 'pt', name: 'Português', flag: 'PT' },
    { code: 'zh', name: '简体中文',  flag: 'CN' },
    { code: 'ko', name: '한국어',    flag: 'KR' },
    { code: 'ja', name: '日本語',    flag: 'JP' },
    { code: 'ru', name: 'Русский',  flag: 'RU' }
  ];
  var byCode = {};
  LANGS.forEach(function (l) { byCode[l.code] = l; });

  var CARET = '<svg class="lp__caret" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var CHECK = '<svg class="lp__check" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3.5 3.5L13 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function current() {
    var r = window.__nexumResolvedLang;
    if (r && byCode[r]) return r;
    var s = null;
    try { s = localStorage.getItem('nexum.lang'); } catch (e) { /* private mode */ }
    if (s && byCode[s]) return s;
    var n = (navigator.language || '').slice(0, 2);
    return byCode[n] ? n : 'en';
  }

  function flag(code, cls) {
    return '<img class="' + cls + '" src="/vendor/flags/' + byCode[code].flag + '.svg" alt="" width="18" height="12">';
  }

  function injectCss() {
    if (document.getElementById('lp-css')) return;
    var css = ''
      + '.lp{position:relative;display:inline-flex}'
      + '.lp__trigger{display:inline-flex;align-items:center;gap:6px;background:var(--panel2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:inherit;font-size:13px;line-height:1;padding:6px 9px;cursor:pointer;transition:border-color .15s ease}'
      + '.lp__trigger:hover{border-color:var(--accent)}'
      + '.lp__trigger:focus-visible{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px rgba(91,155,255,.25)}'
      + '.lp__flag{width:18px;height:12px;border-radius:2px;object-fit:cover;display:block;flex:none;box-shadow:0 0 0 1px rgba(0,0,0,.35)}'
      + '.lp__cur{white-space:nowrap}'
      + '.lp__caret{color:var(--muted);transition:transform .15s ease}'
      + '.lp--open .lp__caret{transform:rotate(180deg)}'
      + '.lp__menu{position:absolute;top:calc(100% + 6px);right:0;z-index:1000;min-width:180px;max-height:60vh;overflow-y:auto;background:var(--panel);border:1px solid var(--border);border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,.6);padding:4px;display:flex;flex-direction:column;gap:2px}'
      // The [hidden] override is required: the display:flex above otherwise beats
      // the UA [hidden]{display:none} rule, leaving the menu visible on load.
      + '.lp__menu[hidden]{display:none}'
      + '.lp__option{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;background:transparent;border:none;border-radius:4px;color:var(--text);font-family:inherit;font-size:13px;line-height:1;text-align:left;cursor:pointer}'
      + '.lp__option:hover{background:var(--panel2)}'
      + '.lp__option[aria-selected="true"]{color:var(--head);font-weight:600}'
      + '.lp__name{flex:1;white-space:nowrap}'
      + '.lp__check{color:var(--accent);flex:none}';
    var style = document.createElement('style');
    style.id = 'lp-css';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function build(host) {
    // SECURITY: every value interpolated into innerHTML below is a hard-coded
    // constant from LANGS (codes, native names, flag codes) or the static
    // CARET/CHECK SVGs. `cur` derives from localStorage/navigator but is
    // validated against byCode and used only as a map key / equality check —
    // never concatenated into the markup raw — so there is no injection vector.
    var cur = current();
    host.classList.add('lp');
    var opts = LANGS.map(function (l) {
      var sel = l.code === cur;
      return '<button type="button" class="lp__option" role="option" data-code="' + l.code + '" aria-selected="' + sel + '">'
        + flag(l.code, 'lp__flag') + '<span class="lp__name">' + l.name + '</span>' + (sel ? CHECK : '') + '</button>';
    }).join('');
    host.innerHTML =
      '<button type="button" class="lp__trigger" aria-haspopup="listbox" aria-expanded="false" aria-label="Language">'
        + flag(cur, 'lp__flag') + '<span class="lp__cur">' + byCode[cur].name + '</span>' + CARET
      + '</button>'
      + '<div class="lp__menu" role="listbox" hidden>' + opts + '</div>';

    var trigger = host.querySelector('.lp__trigger');
    var menu = host.querySelector('.lp__menu');
    function close() { host.classList.remove('lp--open'); menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
    function open() { host.classList.add('lp--open'); menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); }
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      host.classList.contains('lp--open') ? close() : open();
    });
    menu.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.lp__option') : null;
      if (!btn) return;
      var code = btn.getAttribute('data-code');
      try { localStorage.setItem('nexum.lang', code); } catch (err) { /* private mode */ }
      location.reload();
    });
    document.addEventListener('click', function (e) { if (!host.contains(e.target)) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  }

  injectCss();
  var hosts = document.querySelectorAll('[data-lang-picker]');
  for (var i = 0; i < hosts.length; i++) build(hosts[i]);
})();
