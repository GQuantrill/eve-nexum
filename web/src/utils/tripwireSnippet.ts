/**
 * Tripwire has no export, so this imports the JSON its own web client receives.
 *
 * The snippet below is handed to the user to run in the console on their open
 * Tripwire tab: it re-requests their data using the session they already have
 * and copies the reply. Nothing is typed into Nexum but the result, and no
 * Tripwire credentials are involved at any point — which is the whole reason
 * for doing it this way rather than asking for a login.
 *
 * There are two ways to get the data, and which one works depends on the
 * deployment, so it tries both:
 *
 *  1. `api.php?q=/<resource>&maskID=<mask>` returns a whole mask in one call.
 *     Some instances answer it on the session cookie; others don't expose it at
 *     all (a self-hosted one was seen returning 503 for every resource).
 *  2. refresh.php, what the Tripwire page itself polls. Its `wormholes` are
 *     mask-wide, but notes and the non-wormhole signature types come back only
 *     for the system asked about, so this walks the chain to collect them.
 *
 * Path 1 is preferred because of one thing path 2 cannot do on its own: name a
 * system that isn't already known. Only three things in a refresh.php reply are
 * mask-wide — the wormhole signatures, and `flares` and `occupied`, which come
 * back on every reply whatever was asked — so the walk seeds its candidates
 * from all three. That reaches the chain, anything someone flare-marked, and
 * anywhere a mask member is sitting right now.
 *
 * A system that is none of those and was only ever annotated stays invisible:
 * nothing in refresh.php will ever utter its id, so no amount of asking finds
 * it. The only way past that is for a person to name it, which is what the
 * "other systems" box in this dialog is for — the names are baked into the
 * snippet it hands out and resolved through `findSystemID`, the lookup
 * Tripwire's own page already defines. Putting it in the dialog rather than
 * leaving it as a console line is deliberate: the people who need it are
 * exactly the people who won't read console output.
 *
 * The mask id that api.php needs is read off the page — Tripwire keeps the list
 * in `tripwire.masks` with the active one flagged, and renders it into `#mask`
 * as `data-mask`. Recovering it from a signature row instead would fail on a
 * mask with nothing scanned, which has nothing to do with knowing the mask.
 *
 * Two details about the console itself:
 *   - everything sits inside an async IIFE. Tripwire's page declares globals of
 *     its own — `var chain` among them — and a top-level `const chain` collides
 *     with it outright. Scoping also makes the snippet safe to paste twice.
 *   - `copy()` is DevTools' own helper and only exists while the pasted
 *     statement is still running synchronously; by the first `await` it's gone.
 *     So it's captured up front, and the result is parked on `window.twChain`
 *     regardless, leaving `copy(twChain)` as a one-word second step.
 */
// EVE system names and ids are alphanumeric with dashes (C9N-CC, J123456), so
// anything else in the box is dropped rather than escaped into the snippet the
// user is about to run.
const MAX_EXTRA = 50;
export function parseExtraSystems(raw: string): string[] {
  return [...new Set(raw.split(/[\s,]+/).map((t) => t.trim()).filter((t) => /^[A-Za-z0-9-]{1,16}$/.test(t)))]
    .slice(0, MAX_EXTRA);
}

export const buildSnippet = (extra: string[]) => `await (async () => {
  const extra = ${JSON.stringify(extra)};
  const cp = typeof copy === 'function' ? copy : null;
  const here = String(window.viewingSystemID || '');
  if (!here) throw new Error('No system in view - open your Tripwire map first, then run this again.');
  const grab = async (url, what) => {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('replied ' + r.status + ' for ' + what);
    return r.json();
  };
  const byId = rows => Object.fromEntries(rows.map(r => [String(r.id), r]));
  const act = (window.tripwire && Array.isArray(tripwire.masks) && tripwire.masks.find(m => m.active)) || null;
  const el = document.querySelector('#mask [data-mask]') || document.querySelector('#mask-menu .active [data-mask]');
  const mask = String((act && act.mask) || (el && el.dataset.mask) || '');
  let sigs, whs;
  const notes = {};
  try {
    if (!mask) throw new Error('found no mask id on the page');
    const api = res => grab('/api.php?q=/' + res + '&maskID=' + mask, res);
    const [s, w, c] = await Promise.all([api('signatures'), api('wormholes'), api('comments')]);
    sigs = byId(s); whs = byId(w);
    for (const n of c) (notes[String(n.systemID)] = notes[String(n.systemID)] || []).push(n);
  } catch (e) {
    console.log('Whole-mask API unavailable here (' + e.message + ') - walking the chain instead.');
    const init = await grab('/refresh.php?mode=init&systemID=' + here, 'the chain');
    sigs = { ...init.signatures }; whs = { ...init.wormholes };
    const named = v => /^\\d+$/.test(String(v)) ? String(v)
      : String((typeof findSystemID === 'function' && findSystemID(String(v))) || '');
    const ids = [...new Set([
      ...Object.values(sigs).map(x => String(x.systemID)),
      ...(((init.flares || {}).flares) || []).map(f => String(f.systemID)),
      ...(init.occupied || []).map(o => String(o.systemID)),
      ...extra.map(named),
    ])].filter(id => id && id !== '0');
    console.log('Checking ' + ids.length + ' systems (chain, flares, occupancy' + (extra.length ? ', named' : '') + ').');
    console.log('A system that is none of those cannot be named from here - list it in the');
    console.log('import dialog under \\'other systems\\' and copy the snippet again.');
    const sticky = new Map();
    for (const [i, id] of ids.entries()) {
      const r = await grab('/refresh.php?mode=refresh&systemID=' + id + '&signatureCount=-1&signatureTime=1970-01-01&commentCount=-1&commentTime=1970-01-01', 'system ' + id);
      Object.assign(sigs, r.signatures || {});
      for (const n of r.comments || []) n.sticky ? sticky.set(n.id, n) : (notes[id] = notes[id] || []).push(n);
      if (ids.length > 20 && i % 10 === 9) console.log((i + 1) + '/' + ids.length + ' systems...');
    }
    notes['0'] = [...sticky.values()];
    await grab('/refresh.php?mode=refresh&systemID=' + here, 'your own system');
  }
  window.twChain = JSON.stringify({ signatures: sigs, wormholes: whs, origin: here, notes });
  const list = Object.values(sigs);
  const tally = new Set(list.map(x => String(x.systemID))).size + ' systems, ' + list.length
    + ' signatures, ' + Object.values(notes).reduce((n, a) => n + a.length, 0) + ' notes';
  try { cp(twChain); console.log('Copied ' + tally + ' to the clipboard.'); }
  catch (e) { console.log('Collected ' + tally + '. Now run:  copy(twChain)'); }
})();`;
