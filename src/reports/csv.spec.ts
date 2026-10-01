import { describe, expect, it } from 'vitest';
import { csvEscape, toCsv } from './csv.js';

describe('csv helpers', () => {
  it('escapes quotes, commas, and newlines', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line\nbreak')).toBe('"line\nbreak"');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
    expect(csvEscape(new Date('2026-01-01T00:00:00.000Z'))).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('neutralises CSV formula injection with a leading single quote (CWE-1236)', () => {
    // The payload contains double quotes, so the pre-existing wrapping still
    // quotes the field; the neutralising `'` sits directly after the opening
    // quote, immediately before the dangerous formula character.
    expect(csvEscape('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    // Fields without quotes/commas/newlines are only prefixed, never wrapped.
    expect(csvEscape('+SUM(A1)')).toBe(`'+SUM(A1)`);
    expect(csvEscape('-2+3+cmd')).toBe(`'-2+3+cmd`);
    expect(csvEscape('@import os')).toBe(`'@import os`);
    expect(csvEscape('\tcommand')).toBe(`'\tcommand`);
    // A leading CR is also a wrapping trigger under the existing rule.
    expect(csvEscape('\rcommand')).toBe(`"'\rcommand"`);
    // Numbers take the same path as their string form.
    expect(csvEscape(-5)).toBe(`'-5`);
  });

  it('leaves legitimate values byte-identical', () => {
    expect(csvEscape('normal, title')).toBe('"normal, title"');
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape(42)).toBe('42');
    expect(csvEscape('2026-01-15 Event')).toBe('2026-01-15 Event');
    expect(csvEscape(new Date('2026-01-01T00:00:00.000Z'))).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('builds header + rows with CRLF endings', () => {
    const csv = toCsv(['a', 'b'], [
      ['1', 'x,y'],
      [2, null],
    ]);
    expect(csv).toBe('a,b\r\n1,"x,y"\r\n2,\r\n');
  });
});
