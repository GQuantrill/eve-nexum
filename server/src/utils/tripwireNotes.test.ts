import { describe, it, expect } from 'vitest';
import { twNoteText, twNotesBySystem } from './tripwireNotes.js';

describe('twNoteText', () => {
  it('turns the tags Tripwire actually uses into markdown', () => {
    expect(twNoteText('Rolling <b>tonight</b><br>bring a <i>Higgs</i>'))
      .toBe('Rolling **tonight**\nbring a *Higgs*');
  });

  it('flattens paragraphs and lists into lines', () => {
    expect(twNoteText('<p>Exits</p><ul><li>Jita 4</li><li>Amarr 9</li></ul>'))
      .toBe('Exits\n- Jita 4\n- Amarr 9');
  });

  it('drops every other tag rather than passing markup through', () => {
    expect(twNoteText('<script>alert(1)</script>hi<img src=x onerror=y>')).toBe('alert(1)hi');
  });

  it('decodes entities only after tags are gone, so escaped markup stays text', () => {
    // Tripwire escapes what a user typed; decoding first would rebuild a tag
    // that the strip pass has already run past.
    expect(twNoteText('&lt;script&gt;bad&lt;/script&gt;')).toBe('<script>bad</script>');
    expect(twNoteText('Sansha&#39;s &amp; friends')).toBe("Sansha's & friends");
  });

  it('decodes numeric entities and the names a rich-text editor emits', () => {
    expect(twNoteText('Roll the C5 &mdash; then scan &#8212; twice &#x2014; more'))
      .toBe('Roll the C5 \u2014 then scan \u2014 twice \u2014 more');
    // A name we don't carry is left exactly as written rather than guessed at.
    expect(twNoteText('50&percnt; mass')).toBe('50&percnt; mass');
  });

  it('decodes entities in one pass, so a doubly-escaped tag stays text', () => {
    expect(twNoteText('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  it('caps a single note and ignores non-strings', () => {
    expect(twNoteText('x'.repeat(5_000))).toHaveLength(4_000);
    expect(twNoteText(null)).toBe('');
    expect(twNoteText(42)).toBe('');
  });

  it('collapses the blank lines a rich-text editor leaves behind', () => {
    expect(twNoteText('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb');
  });
});

describe('twNotesBySystem', () => {
  const note = (comment: string, createdByName?: string) => ({ comment, createdByName });

  it('keys notes by system and credits the author', () => {
    const out = twNotesBySystem({ '30000142': [note('Camped', 'Cpt Scout')] }, null);
    expect(out.get(30000142)).toBe('Camped\n\n*-- Cpt Scout*');
  });

  it('stacks several notes for one system under a rule', () => {
    const out = twNotesBySystem({ '30000142': [note('first'), note('second')] }, null);
    expect(out.get(30000142)).toBe('first\n\n---\n\nsecond');
  });

  it('puts the map-wide sticky note on the system the import ran from', () => {
    const out = twNotesBySystem({ '0': [note('Home is J123456')] }, 30000142);
    expect(out.get(30000142)).toBe('--- map-wide note from Tripwire ---\nHome is J123456');
  });

  it('drops the sticky note when there is no origin to hang it on', () => {
    expect(twNotesBySystem({ '0': [note('Home is J123456')] }, null).size).toBe(0);
  });

  it('ignores junk keys, junk values and empty notes', () => {
    const out = twNotesBySystem(
      { abc: [note('x')], '-5': [note('x')], '30000142': 'not an array', '30000144': [note('<p></p>')] },
      null,
    );
    expect(out.size).toBe(0);
  });

  it('returns nothing for a payload that is not an object', () => {
    expect(twNotesBySystem(undefined, 1).size).toBe(0);
    expect(twNotesBySystem([], 1).size).toBe(0);
  });

  it('caps the stacked note for one system', () => {
    const rows = Array.from({ length: 10 }, () => note('y'.repeat(3_000)));
    expect(twNotesBySystem({ '30000142': rows }, null).get(30000142)).toHaveLength(8_000);
  });
});
