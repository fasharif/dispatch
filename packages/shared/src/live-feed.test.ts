import { describe, expect, it } from 'vitest';
import { LiveFeed } from './live-feed.js';
import { compareStreamIds, fixKey, type DriverLocationEvent } from './realtime.js';

const event = (id: string, deviceId: string, seq: number): DriverLocationEvent => ({
  id,
  driverId: 'driver',
  deviceId,
  seq,
  lat: 25.2,
  lng: 55.3,
  accuracyM: null,
  speedMps: null,
  headingDeg: null,
  recordedAt: '2026-09-20T10:00:00.000Z',
  sentAt: null,
  publishedAt: 0,
});

describe('compareStreamIds', () => {
  it('compares the millisecond part numerically, then the sequence', () => {
    expect(compareStreamIds('1700000000000-0', '1700000000001-0')).toBeLessThan(0);
    expect(compareStreamIds('1700000000000-10', '1700000000000-9')).toBeGreaterThan(0);
    expect(compareStreamIds('999-0', '1000-0')).toBeLessThan(0);
    expect(compareStreamIds('5-5', '5-5')).toBe(0);
  });
});

describe('LiveFeed', () => {
  it('drops a fix it has already seen, even under a new stream id', () => {
    const feed = new LiveFeed();
    expect(feed.accept(event('1000-0', 'dev-a', 1))).toBe(true);
    expect(feed.accept(event('1000-1', 'dev-a', 2))).toBe(true);
    // The same fix published twice (a replay racing the original) has a different stream id.
    expect(feed.accept(event('1005-0', 'dev-a', 1))).toBe(false);
    expect(feed.accept(event('1006-0', 'dev-b', 1))).toBe(true);
    expect(feed.size).toBe(3);
    expect(fixKey(event('x', 'dev-a', 7))).toBe('dev-a:7');
  });

  it('resumes from before the newest id, so out-of-order events are read again', () => {
    const feed = new LiveFeed({ resumeOverlapMs: 5_000 });
    expect(feed.resumeFrom()).toBeNull();
    feed.accept(event('1700000010000-3', 'dev-a', 1));
    feed.accept(event('1700000008000-0', 'dev-b', 1));
    expect(feed.newest).toBe('1700000010000-3');
    expect(feed.resumeFrom()).toBe('1700000005000-0');
  });

  it('forgets the oldest keys beyond its memory limit', () => {
    const feed = new LiveFeed({ maxRemembered: 2 });
    feed.accept(event('1-0', 'a', 1));
    feed.accept(event('2-0', 'a', 2));
    feed.accept(event('3-0', 'a', 3));
    expect(feed.size).toBe(2);
    expect(feed.accept(event('4-0', 'a', 1))).toBe(true);
    expect(feed.accept(event('5-0', 'a', 3))).toBe(false);
  });
});
