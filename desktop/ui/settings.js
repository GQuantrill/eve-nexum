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
  $('startAtLogin').checked = s.startAtLogin;
  // The Store build has no "start at login" (see lib.rs, STORE).
  const info = await invoke('desktop_info');
  if (info.store) {
    $('startAtLogin').closest('label').style.display = 'none';
    $('startAtLogin').closest('label').nextElementSibling.style.display = 'none';
  }
  $('chatlogDir').value = s.chatlogDir || '';
  $('intelSound').checked = s.intelSound;
  // Intel sound and voice: for anything on the map, or within N jumps.
  const showRange = () => {
    const jumps = $('alertRangeMode').value === 'jumps';
    $('alertRangeJumps').style.display = jumps ? '' : 'none';
    $('alertRangeUnit').style.display = jumps ? '' : 'none';
  };
  $('alertRangeMode').value = s.intelAlertRange == null ? 'map' : 'jumps';
  $('alertRangeJumps').value = String(s.intelAlertRange ?? 5);
  $('alertRangeMode').addEventListener('change', showRange);
  showRange();
  $('intelSpeak').checked = s.intelSpeak;

  // Speech: volume, voice (the voices installed on this computer), speed,
  // and a test that speaks with what's chosen right now, saved or not.
  const RATES = { slow: 0.8, normal: 1, fast: 1.3 };
  // Some Linux systems have no speech at all: don't offer it there.
  if (typeof speechSynthesis === 'undefined') {
    for (const el of [$('intelSpeak').closest('label'), $('intelSpeak').closest('label').nextElementSibling, $('speech')]) {
      el.style.display = 'none';
    }
  }
  $('speakVolume').value = String(s.intelSpeakVolume ?? 100);
  $('speakRate').value = s.intelSpeakRate || 'normal';
  const showVolume = () => { $('speakVolumeOut').textContent = `${$('speakVolume').value}%`; };
  showVolume();
  $('speakVolume').addEventListener('input', showVolume);
  const fillVoices = () => {
    const sel = $('speakVoice');
    const want = sel.value || s.intelSpeakVoice || '';
    const voices = typeof speechSynthesis === 'undefined' ? [] : speechSynthesis.getVoices();
    sel.replaceChildren(sel.options[0], ...voices.map((v) => {
      const o = document.createElement('option');
      o.value = v.voiceURI;
      o.textContent = `${v.name} (${v.lang})`;
      return o;
    }));
    sel.value = voices.some((v) => v.voiceURI === want) ? want : '';
  };
  fillVoices();
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener('voiceschanged', fillVoices);
  const speechOn = () => { $('speech').classList.toggle('off', !$('intelSpeak').checked); };
  speechOn();
  $('intelSpeak').addEventListener('change', speechOn);
  $('speakTest').addEventListener('click', () => {
    if (typeof speechSynthesis === 'undefined') return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t.speakSample);
    u.lang = navigator.language;
    u.volume = Number($('speakVolume').value) / 100;
    u.rate = RATES[$('speakRate').value] ?? 1;
    const voice = speechSynthesis.getVoices().find((v) => v.voiceURI === $('speakVoice').value);
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  });
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
        startAtLogin: $('startAtLogin').checked,
        chatlogDir: $('chatlogDir').value.trim() || null,
        intelChannels: channels,
        intelSound: $('intelSound').checked,
        intelAlertRange: $('alertRangeMode').value === 'jumps'
          ? Math.min(50, Math.max(0, Math.round(Number($('alertRangeJumps').value) || 0)))
          : null,
        intelSpeak: $('intelSpeak').checked,
        intelSpeakVolume: Number($('speakVolume').value),
        intelSpeakRate: $('speakRate').value,
        intelSpeakVoice: $('speakVoice').value || null,
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
