// The overlay window: intel near you, nearest first. Local page; the Nexum
// window works out the list and the app passes it here (overlay.rs).
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);

// Reports older than this drop off (the same five minutes the map keeps them).
const MAX_AGE_MS = 5 * 60_000;

async function strings() {
  const all = await (await fetch('i18n.json')).json();
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return { ...all.en, ...(all[lang] || {}) };
}

(async () => {
  const t = await strings();
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t[el.dataset.t]; });
  let data = { here: null, reports: [] };

  const ago = (at) => {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
  };
  const render = () => {
    $('here').textContent = data.here ? t.overlayHere.replace('{system}', data.here) : '';
    const now = Date.now();
    const rows = data.reports.filter((r) => now - r.at <= MAX_AGE_MS);
    $('empty').style.display = rows.length ? 'none' : '';
    $('list').replaceChildren(...rows.map((r) => {
      const li = document.createElement('li');
      li.className = r.jumps == null ? 'far' : r.jumps <= 2 ? 'near' : r.jumps <= 5 ? 'mid' : 'far';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = r.name;
      const jumps = document.createElement('span');
      jumps.className = 'jumps';
      jumps.textContent = r.jumps == null ? '' : r.jumps === 0 ? t.overlayInSystem : t.overlayJumps.replace('{n}', r.jumps);
      const when = document.createElement('span');
      when.className = 'ago';
      when.textContent = ago(r.at);
      li.append(name, jumps, when);
      return li;
    }));
  };

  try { data = await invoke('overlay_state'); } catch { /* nothing yet */ }
  render();
  listen('nexum://overlay', ({ payload }) => { data = payload; render(); });
  setInterval(render, 5000);
})();
