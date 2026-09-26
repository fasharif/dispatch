import { webhookEnvelopeSchema } from '@dispatch/shared';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyWebhook } from './webhook-signature.js';

/**
 * The webhook contract with TopFlow Hub, pinned by requests recorded from the end-to-end delivery
 * flow (see test/fixtures/README.md). This file checks that the recording verifies and parses
 * with dispatch's own schema; the end-to-end test checks that what the relay sends now still has
 * the recorded shape; TopFlow Hub's tests check the same file with its schema and verifier. The
 * copy in TopFlow Hub is kept in step by hand: record again, copy, run both suites.
 */
interface RecordedRequest {
  headers: Record<'x-dispatch-event-id' | 'x-dispatch-event-type' | 'x-dispatch-signature', string>;
  body: string;
}
const fixture = JSON.parse(
  readFileSync(new URL('../../test/fixtures/webhooks.recorded.json', import.meta.url), 'utf8'),
) as { secret: string; requests: RecordedRequest[] };

describe('recorded webhooks (contract with TopFlow Hub)', () => {
  it('covers the assigned, picked-up and completed events of one delivery', () => {
    expect(fixture.requests.map((r) => r.headers['x-dispatch-event-type'])).toEqual([
      'delivery.assigned',
      'delivery.picked_up',
      'delivery.completed',
    ]);
    const deliveries = fixture.requests.map(
      (r) => webhookEnvelopeSchema.parse(JSON.parse(r.body)).data.deliveryId,
    );
    expect(new Set(deliveries).size).toBe(1);
  });

  it.each(fixture.requests.map((r) => [r.headers['x-dispatch-event-type'], r] as const))(
    '%s: verifies, parses and matches its headers',
    (_type, request) => {
      const signature = request.headers['x-dispatch-signature'];
      const timestamp = Number(/t=(\d+)/.exec(signature)?.[1]);
      expect(verifyWebhook(fixture.secret, request.body, signature, 300, timestamp).valid).toBe(
        true,
      );
      expect(verifyWebhook('another-secret', request.body, signature, 300, timestamp).valid).toBe(
        false,
      );
      const envelope = webhookEnvelopeSchema.parse(JSON.parse(request.body));
      expect(envelope.id).toBe(request.headers['x-dispatch-event-id']);
      expect(envelope.type).toBe(request.headers['x-dispatch-event-type']);
    },
  );

  it('carries the proof of delivery TopFlow Hub records on delivery.completed', () => {
    const completed = fixture.requests.find(
      (r) => r.headers['x-dispatch-event-type'] === 'delivery.completed',
    );
    const envelope = webhookEnvelopeSchema.parse(JSON.parse(completed?.body ?? '{}'));
    expect(envelope.data).toMatchObject({
      status: 'delivered',
      proof: { withinGeofence: true, hasPhoto: true, hasSignature: true },
    });
    expect(envelope.data.orderReference.length).toBeLessThanOrEqual(64);
  });
});
