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

  it('builds header + rows with CRLF endings', () => {
    const csv = toCsv(['a', 'b'], [
      ['1', 'x,y'],
      [2, null],
    ]);
    expect(csv).toBe('a,b\r\n1,"x,y"\r\n2,\r\n');
  });
});
