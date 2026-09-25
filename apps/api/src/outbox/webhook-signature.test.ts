import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhook } from './webhook-signature.js';

const SECRET = 'whsec-unit-test-unit-test-unit-test-00';
const BODY = '{"id":"e1","type":"delivery.completed"}';

describe('webhook signatures', () => {
  it('signs "<timestamp>.<body>" with HMAC-SHA256', () => {
    const header = signWebhook(SECRET, BODY, 1_790_000_000.9);
    const expected = createHmac('sha256', SECRET).update(`1790000000.${BODY}`).digest('hex');
    expect(header).toBe(`t=1790000000,v1=${expected}`);
  });

  it('accepts its own signature within the tolerance window', () => {
    const header = signWebhook(SECRET, BODY, 1_790_000_000);
    expect(verifyWebhook(SECRET, BODY, header, 300, 1_790_000_100)).toEqual({
      valid: true,
      timestamp: 1_790_000_000,
    });
  });

  it('rejects old or future timestamps (replays)', () => {
    const header = signWebhook(SECRET, BODY, 1_790_000_000);
    expect(verifyWebhook(SECRET, BODY, header, 300, 1_790_000_301)).toEqual({
      valid: false,
      reason: 'expired',
    });
    expect(verifyWebhook(SECRET, BODY, header, 300, 1_789_999_699)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it('rejects a changed body, a changed timestamp and another secret', () => {
    const header = signWebhook(SECRET, BODY, 1_790_000_000);
    const now = 1_790_000_000;
    expect(verifyWebhook(SECRET, `${BODY} `, header, 300, now).valid).toBe(false);
    expect(
      verifyWebhook(SECRET, BODY, header.replace('t=1790000000', 't=1790000001'), 300, now).valid,
    ).toBe(false);
    expect(verifyWebhook(`${SECRET}x`, BODY, header, 300, now)).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('accepts any matching v1 value, which allows secret rotation on the sender side', () => {
    const good = signWebhook(SECRET, BODY, 1_790_000_000).split(',')[1] ?? '';
    const header = `t=1790000000,v1=${'0'.repeat(64)},${good}`;
    expect(verifyWebhook(SECRET, BODY, header, 300, 1_790_000_000).valid).toBe(true);
  });

  it('rejects malformed headers', () => {
    for (const header of [
      undefined,
      '',
      't=abc,v1=00',
      'v1=' + '0'.repeat(64),
      't=1790000000',
      't=1790000000,v1=xyz',
    ]) {
      expect(verifyWebhook(SECRET, BODY, header, 300, 1_790_000_000)).toEqual({
        valid: false,
        reason: 'malformed',
      });
    }
  });
});
