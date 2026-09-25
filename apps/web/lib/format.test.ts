import { describe, expect, it } from 'vitest';
import { formatAge, formatDistance, formatShortDuration, signaturePath } from './format';

describe('console formatting', () => {
  it('formats distances in metres and kilometres', () => {
    expect(formatDistance(842.4)).toBe('842 m');
    expect(formatDistance(1_234)).toBe('1.2 km');
    expect(formatDistance(18_760)).toBe('19 km');
  });

  it('formats durations', () => {
    expect(formatShortDuration(45)).toBe('45 s');
    expect(formatShortDuration(12 * 60 + 20)).toBe('12 min');
    expect(formatShortDuration(65 * 60)).toBe('1 h 05 min');
  });

  it('describes how old a fix is', () => {
    const now = Date.parse('2026-09-20T10:00:00Z');
    expect(formatAge('2026-09-20T09:59:58Z', now)).toBe('just now');
    expect(formatAge('2026-09-20T09:59:20Z', now)).toBe('40 s ago');
    expect(formatAge('2026-09-20T09:57:00Z', now)).toBe('3 min ago');
    expect(formatAge('2026-09-20T07:30:00Z', now)).toBe('2 h ago');
  });

  it('turns signature strokes into SVG path data', () => {
    expect(
      signaturePath([
        [10, 20, 30, 40],
        [5, 5, 6, 6, 7, 7],
      ]),
    ).toBe('M10 20 L30 40 M5 5 L6 6 L7 7');
  });
});
