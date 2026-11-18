// The app's own settings window. Local page, talks only to the app.
const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

async function strings() {
  const all = await (await fetch('i18n.json')).json();
  const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return { ...all.en, ...(all[lang] || {}) };
}

(async () => {
  const t = await strings();
  document.title = t.title;
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t[el.dataset.t]; });

  const s = await invoke('get_settings');
  $('serverUrl').value = s.serverUrl;
  $('alwaysOnTop').checked = s.alwaysOnTop;
  $('readLogs').checked = s.readLogs;
  $('watchClipboard').checked = s.watchClipboard;
  $('chatlogDir').value = s.chatlogDir || '';
  $('intelSound').checked = s.intelSound;
  $('intelPulseSecs').querySelectorAll('option').forEach((o) => { o.textContent = t.seconds.replace('{n}', o.value); });
  $('intelPulse').value = s.intelPulse;
  $('intelPulseSecs').value = String(s.intelPulseSecs);
  let channels = [...(s.intelChannels || [])];
  const drawChannels = () => {
    const list = $('intelList');
    list.replaceChildren(...channels.map((c, i) => {
      const li = document.createElement('li');
      const name = document.createElement('div');
      const label = document.createElement('span');
      label.textContent = c;
      const info = document.createElement('small');
      info.className = 'status';
      info.dataset.channel = c.toLowerCase();
      name.append(label, info);
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'link'; rm.textContent = t.intelRemove;
      rm.addEventListener('click', () => { channels.splice(i, 1); drawChannels(); });
      li.append(name, rm);
      return li;
    }));
  };
  drawChannels();

  // Which file each saved channel is following, refreshed while open.
  const showStatus = async () => {
    let status = [];
    try { status = await invoke('intel_status'); } catch { return; }
    document.querySelectorAll('#intelList .status').forEach((el) => {
      const st = status.find((x) => x.channel.toLowerCase() === el.dataset.channel);
      if (!st) { el.textContent = ''; return; }
      if (!st.file) { el.textContent = t.intelNoLog; return; }
      const last = st.lastLineAt ? ` - ${t.intelLast} ${new Date(st.lastLineAt).toLocaleTimeString()}` : '';
      el.textContent = `${t.intelFollowing} ${st.file}${last}`;
    });
  };
  showStatus();
  setInterval(showStatus, 2000);
  const addChannel = () => {
    // A pasted file name loses its date/time/character part here and again
    // in the app, which keeps only the channel name.
    const c = $('intelNew').value.trim().replace(/_\d{8}_\d{6}(_\d+)?(\.txt)?$/i, '');
    if (c && !channels.some((x) => x.toLowerCase() === c.toLowerCase())) channels.push(c);
    $('intelNew').value = '';
    drawChannels();
  };
  $('intelAdd').addEventListener('click', addChannel);
  $('intelNew').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addChannel(); } });
  $('defaultDir').textContent = (await invoke('default_chatlog_dir')) || '';

  $('resetServer').addEventListener('click', () => { $('serverUrl').value = 'https://eve-nexum.com'; });

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('intelNew').value.trim()) addChannel();
    const status = $('status');
    status.className = '';
    try {
      await invoke('save_settings', { settings: {
        serverUrl: $('serverUrl').value,
        alwaysOnTop: $('alwaysOnTop').checked,
        readLogs: $('readLogs').checked,
        watchClipboard: $('watchClipboard').checked,
        chatlogDir: $('chatlogDir').value.trim() || null,
        intelChannels: channels,
        intelSound: $('intelSound').checked,
        intelPulse: $('intelPulse').value,
        intelPulseSecs: Number($('intelPulseSecs').value),
      } });
      status.textContent = t.saved;
    } catch {
      status.className = 'bad';
      status.textContent = t.badServer;
    }
  });
})();
