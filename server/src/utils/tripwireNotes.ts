// Tripwire system notes -> Nexum system notes.
//
// Tripwire stores a system's notes as HTML (its note box is a rich-text
// editor) and serves them one system at a time; the import snippet walks the
// chain and hands the lot over keyed by system id. Converting that text lives
// here rather than in the route so it can be tested on its own — it is the one
// part of the import that takes free text written by strangers.
export interface TwComment { comment?: unknown; createdByName?: unknown }

// A single Tripwire comment, and the whole stack for one system, both capped.
// Notes are free text written by other people; the caps keep one long-winded
// system from filling the column.
const MAX_TW_NOTE_LEN = 4_000;
const MAX_SYS_NOTE_LEN = 8_000;

// The named entities a rich-text editor actually produces. Everything else is
// numeric, which decodes on its own below; an unknown name is left as written
// rather than guessed at.
const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', bull: '\u2022', middot: '\u00b7',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  deg: '\u00b0', times: '\u00d7', frac12: '\u00bd',
};

// Remove tag-shaped spans until the text stops changing. A single pass can
// splice two fragments into a fresh tag — `<b<b>>` survives one removal as
// `<b>` — so removing once is not the same as removing. Bounded, because the
// point is to terminate on hostile input, not to win a race with it: whatever
// still looks like markup after a few passes loses its angle brackets outright.
const MAX_STRIP_PASSES = 5;
function stripTags(input: string): string {
  let out = input;
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass++) {
    const next = out.replace(/<[^>]*>/g, '');
    if (next === out) return out;
    out = next;
  }
  return out.replace(/[<>]/g, '');
}

/**
 * Tripwire stores its system comments as HTML — its note box is a rich-text
 * editor — while ours are markdown rendered through a sanitiser. Convert the
 * few tags that carry meaning and drop the rest.
 *
 * Every pattern here is linear with no nested quantifier, so a hostile note
 * can't stall the request. Order matters twice: tags are stripped before
 * entities are decoded, and entities are decoded in a single pass, so neither
 * an escaped `&lt;script&gt;` nor a doubly-escaped `&amp;lt;` can be
 * reassembled into markup.
 */
export function twNoteText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // Turn the handful of tags that carry meaning into their markdown equivalent.
  // These are single-pass and can leave a tag behind on spliced input, which is
  // why the strip that follows has to be the thorough one.
  const converted = raw.slice(0, MAX_TW_NOTE_LEN)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/?(b|strong)>/gi, '**')
    .replace(/<\/?(i|em)>/gi, '*');

  return stripTags(converted)
    .replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
      if (body[0] !== '#') return HTML_ENTITIES[body.toLowerCase()] ?? whole;
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fold Tripwire's comments into one note per system. A system can carry
 * several, each with an author, so they stack under a rule in feed order.
 *
 * Key "0" is Tripwire's map-wide sticky note, which has nowhere of its own
 * here — it lands on the system the import was run from, labelled, rather
 * than being dropped or repeated on every system in the chain.
 */
export function twNotesBySystem(raw: unknown, origin: number | null): Map<number, string> {
  const out = new Map<number, string>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  const stack = (rows: TwComment[]): string => rows
    .map((c) => {
      const text = twNoteText(c?.comment);
      if (!text) return '';
      const who = typeof c?.createdByName === 'string' ? c.createdByName.trim().slice(0, 60) : '';
      return who ? `${text}\n\n*-- ${who}*` : text;
    })
    .filter(Boolean)
    .join('\n\n---\n\n');

  for (const [key, rows] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue;
    const sysId = key === '0' ? origin : Number(key);
    if (sysId == null || !Number.isInteger(sysId) || sysId <= 0) continue;
    const body = stack(rows as TwComment[]);
    if (!body) continue;
    const text = key === '0' ? `--- map-wide note from Tripwire ---\n${body}` : body;
    const prev = out.get(sysId);
    out.set(sysId, (prev ? `${prev}\n\n---\n\n${text}` : text).slice(0, MAX_SYS_NOTE_LEN));
  }
  return out;
}
