import { describe, expect, it } from 'vitest';
import { MESSAGES, direction, fill, formatDuration, formatTime, negotiateLocale } from './i18n';

describe('negotiateLocale', () => {
  it('prefers the saved choice', () => {
    expect(negotiateLocale('ar', 'en-GB,en;q=0.9')).toBe('ar');
    expect(negotiateLocale('en', 'ar-AE')).toBe('en');
  });

  it('takes the highest-ranked supported language from Accept-Language', () => {
    expect(negotiateLocale(undefined, 'ar-AE,ar;q=0.9,en;q=0.8')).toBe('ar');
    expect(negotiateLocale(undefined, 'fr-FR,fr;q=0.9,ar;q=0.8,en;q=0.7')).toBe('ar');
    expect(negotiateLocale(undefined, 'en;q=0.5,ar;q=0.9')).toBe('ar');
    expect(negotiateLocale(undefined, 'ur-PK,hi;q=0.8')).toBe('en');
    expect(negotiateLocale('xx', null)).toBe('en');
  });

  it('ignores languages the browser rules out with q=0', () => {
    expect(negotiateLocale(undefined, 'ar;q=0,en;q=0.5')).toBe('en');
  });
});

describe('messages', () => {
  it('has every English key in Arabic too, with the same placeholders', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, english] of Object.entries(MESSAGES.en)) {
      const arabic = (MESSAGES.ar as Record<string, unknown>)[key];
      expect(arabic, key).toBeDefined();
      if (typeof english === 'string') {
        expect(placeholders(arabic as string), key).toEqual(placeholders(english));
      }
    }
  });

  it('writes Arabic right to left', () => {
    expect(direction('ar')).toBe('rtl');
    expect(direction('en')).toBe('ltr');
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(fill('Arriving in about {duration}', { duration: '5 minutes' })).toBe(
      'Arriving in about 5 minutes',
    );
    expect(fill('{missing}', {})).toBe('{missing}');
  });
});

describe('formatting', () => {
  it('rounds travel time up to whole minutes, with the plural rules of each language', () => {
    expect(formatDuration(30, 'en')).toBe('1 minute');
    expect(formatDuration(61, 'en')).toBe('2 minutes');
    expect(formatDuration(12 * 60, 'en')).toBe('12 minutes');
    expect(formatDuration(3 * 3600, 'en')).toBe('3 hours');
    expect(formatDuration(12 * 60, 'ar')).toContain('دقيقة');
    expect(formatDuration(2 * 60, 'ar')).toContain('دقيقتان');
  });

  it('shows clock times in Dubai time', () => {
    // 10:05 UTC is 14:05 in Dubai (UTC+4, no daylight saving).
    expect(formatTime('2026-09-20T10:05:00Z', 'en')).toMatch(/^2:05\s?pm$/i);
    expect(formatTime('2026-09-20T10:05:00Z', 'ar')).toMatch(/م$/);
  });
});
