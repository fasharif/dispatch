import { describe, expect, it } from 'vitest';
import { createDeliverySchema, proofOfDeliverySchema, signatureSchema } from './deliveries.js';
import { enrolDeviceSchema, loginSchema } from './drivers.js';
import { locationBatchSchema } from './locations.js';
import { webhookEnvelopeSchema } from './webhooks.js';

const point = (seq: number, key: string) => ({
  seq,
  idempotencyKey: key,
  recordedAt: '2026-09-20T10:00:00.000Z',
  lat: 25.2,
  lng: 55.27,
});
const KEY_A = '7b0e8f2e-8d0a-4c55-9d6f-2f1d3c4b5a61';
const KEY_B = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

describe('location batches', () => {
  it('accepts a well-formed batch', () => {
    const parsed = locationBatchSchema.parse({
      points: [point(0, KEY_A), point(1, KEY_B)],
      sentAt: 1_790_000_000_000,
    });
    expect(parsed.points).toHaveLength(2);
  });

  it('rejects repeated sequence numbers or keys inside one batch', () => {
    expect(
      locationBatchSchema.safeParse({ points: [point(1, KEY_A), point(1, KEY_B)] }).success,
    ).toBe(false);
    expect(
      locationBatchSchema.safeParse({ points: [point(1, KEY_A), point(2, KEY_A)] }).success,
    ).toBe(false);
  });

  it('rejects out-of-range coordinates, negative sequences and empty batches', () => {
    expect(
      locationBatchSchema.safeParse({ points: [{ ...point(0, KEY_A), lat: 91 }] }).success,
    ).toBe(false);
    expect(locationBatchSchema.safeParse({ points: [point(-1, KEY_A)] }).success).toBe(false);
    expect(locationBatchSchema.safeParse({ points: [] }).success).toBe(false);
  });

  it('requires a UUID idempotency key and an ISO timestamp with a time zone', () => {
    expect(locationBatchSchema.safeParse({ points: [point(0, 'not-a-uuid')] }).success).toBe(false);
    expect(
      locationBatchSchema.safeParse({
        points: [{ ...point(0, KEY_A), recordedAt: '2026-09-20 10:00' }],
      }).success,
    ).toBe(false);
  });
});

describe('deliveries', () => {
  const valid = {
    orderReference: 'TF-SO-2026-000123',
    recipientName: 'Aisha Rahman',
    recipientPhone: '+971 50 123 4567',
    address: 'Villa 12, Street 4, Al Barsha 2, Dubai',
    pickup: { lat: 25.0657, lng: 55.1713 },
    dropoff: { lat: 25.1124, lng: 55.2006 },
  };

  it('defaults autoAssign to false and trims text', () => {
    const parsed = createDeliverySchema.parse({ ...valid, recipientName: '  Aisha Rahman ' });
    expect(parsed.autoAssign).toBe(false);
    expect(parsed.recipientName).toBe('Aisha Rahman');
  });

  it('rejects unsafe order references and bad phone numbers', () => {
    expect(createDeliverySchema.safeParse({ ...valid, orderReference: '<script>' }).success).toBe(
      false,
    );
    expect(createDeliverySchema.safeParse({ ...valid, recipientPhone: 'call me' }).success).toBe(
      false,
    );
  });
});

describe('signatures and proof of delivery', () => {
  const signature = { width: 300, height: 150, strokes: [[10, 10, 20, 25, 30, 40]] };

  it('accepts strokes made of coordinate pairs', () => {
    expect(signatureSchema.safeParse(signature).success).toBe(true);
  });

  it('rejects odd-length strokes and empty signatures', () => {
    expect(signatureSchema.safeParse({ ...signature, strokes: [[1, 2, 3]] }).success).toBe(false);
    expect(signatureSchema.safeParse({ ...signature, strokes: [] }).success).toBe(false);
  });

  it('rejects signatures with too many points', () => {
    const stroke = Array.from({ length: 4000 }, (_, i) => i % 300);
    const strokes = Array.from({ length: 3 }, () => stroke);
    expect(signatureSchema.safeParse({ ...signature, strokes }).success).toBe(false);
  });

  it('requires a position and a capture time', () => {
    const proof = {
      recipientName: 'Aisha',
      position: { lat: 25.1124, lng: 55.2006 },
      capturedAt: '2026-09-20T10:00:00+04:00',
      signature,
    };
    expect(proofOfDeliverySchema.safeParse(proof).success).toBe(true);
    expect(proofOfDeliverySchema.safeParse({ ...proof, position: undefined }).success).toBe(false);
  });
});

describe('accounts and devices', () => {
  it('normalises the login email', () => {
    expect(loginSchema.parse({ email: ' Dispatcher@Example.COM ', password: 'x' }).email).toBe(
      'dispatcher@example.com',
    );
  });

  it('accepts enrolment codes typed with spaces, dashes or lower case', () => {
    expect(enrolDeviceSchema.parse({ code: 'abcd-efgh', deviceName: 'Pixel' }).code).toBe(
      'ABCDEFGH',
    );
    expect(enrolDeviceSchema.safeParse({ code: 'ABC', deviceName: 'Pixel' }).success).toBe(false);
  });
});

describe('webhook envelope', () => {
  it('parses a delivery.completed event', () => {
    const parsed = webhookEnvelopeSchema.parse({
      id: KEY_A,
      type: 'delivery.completed',
      createdAt: '2026-09-20T10:00:00.000Z',
      data: {
        deliveryId: KEY_B,
        orderReference: 'TF-SO-2026-000123',
        status: 'delivered',
        occurredAt: '2026-09-20T10:00:00.000Z',
        driver: { id: KEY_A, name: 'Omar' },
        proof: {
          recipientName: 'Aisha',
          capturedAt: '2026-09-20T09:59:00.000Z',
          withinGeofence: true,
          distanceMeters: 12.5,
          hasPhoto: true,
          hasSignature: true,
        },
      },
    });
    expect(parsed.data.proof?.withinGeofence).toBe(true);
  });

  it('rejects unknown event types', () => {
    expect(
      webhookEnvelopeSchema.safeParse({
        id: KEY_A,
        type: 'delivery.teleported',
        createdAt: '2026-09-20T10:00:00.000Z',
        data: {},
      }).success,
    ).toBe(false);
  });
});
