import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { buildSnippet, parseExtraSystems } from './tripwireSnippet';

// Parse the snippet rather than compiling it with `new Function`. Both answer
// "is this valid JavaScript", but parsing never produces an executable, so
// nothing here can run the string it is checking.
const syntaxErrors = (code: string): number =>
  (ts.transpileModule(code, {
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).diagnostics ?? []).length;

describe('parseExtraSystems', () => {
  it('accepts either commas or whitespace as the separator', () => {
    expect(parseExtraSystems('J123456, C9N-CC')).toEqual(['J123456', 'C9N-CC']);
    expect(parseExtraSystems('J123456  C9N-CC\nT2-V8F')).toEqual(['J123456', 'C9N-CC', 'T2-V8F']);
  });

  it('drops anything that is not shaped like a system name', () => {
    // The names land inside a script the user is about to run, so nothing that
    // could close the literal gets through in the first place.
    expect(parseExtraSystems('J123456, <script>, a"b, ok-1')).toEqual(['J123456', 'ok-1']);
    expect(parseExtraSystems('"]);alert(1);//')).toEqual([]);
  });

  it('de-duplicates and ignores empty input', () => {
    expect(parseExtraSystems('Jita, Jita')).toEqual(['Jita']);
    expect(parseExtraSystems('   ')).toEqual([]);
    expect(parseExtraSystems(',,,')).toEqual([]);
  });

  it('caps the list', () => {
    expect(parseExtraSystems(Array.from({ length: 60 }, (_, i) => `J${i}`).join(','))).toHaveLength(50);
  });
});

describe('buildSnippet', () => {
  it('bakes the named systems into the script', () => {
    expect(buildSnippet(['J123456', 'C9N-CC'])).toContain('const extra = ["J123456","C9N-CC"];');
  });

  it('is valid JavaScript with or without extras', () => {
    for (const extra of [[], ['J123456']]) {
      expect(syntaxErrors(buildSnippet(extra))).toBe(0);
    }
  });

  it('the syntax check would actually catch a broken snippet', () => {
    // Guards the guard: a checker that passes everything proves nothing.
    expect(syntaxErrors('await (async () => { const a = ; })();')).toBeGreaterThan(0);
  });

  it('asks Tripwire for the whole mask before falling back to a walk', () => {
    const s = buildSnippet([]);
    expect(s).toContain("api.php?q=/");
    expect(s).toContain('refresh.php?mode=init');
    expect(s.indexOf('api.php?q=/')).toBeLessThan(s.indexOf('refresh.php?mode=init'));
  });
});
