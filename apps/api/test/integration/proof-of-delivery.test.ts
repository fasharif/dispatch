import type { DeliveryDetailDto, DeliveryDto, WebhookEnvelope } from '@dispatch/shared';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Api,
  PNG_1X1,
  createDelivery,
  enrolDriver,
  moveTo,
  proofForm,
  resetState,
  startApp,
  type TestApp,
  type TestDriver,
} from '../support/harness.js';

// Drop-off used by deliveryInput(): Al Barsha 2 (25.0971, 55.2019).
const DROPOFF = { lat: 25.0971, lng: 55.2019 };
/** About 100 m north of the drop-off (0.0009° of latitude ≈ 99.8 m). */
const AT_THE_GATE = { lat: 25.098, lng: 55.2019 };
/** About 222 m north: outside the 150 m fence even with the 50 m accuracy allowance. */
const DOWN_THE_ROAD = { lat: 25.0991, lng: 55.2019 };
/** About 177 m north: outside 150 m, inside 150 m + a 30 m accuracy allowance. */
const NEAR_THE_EDGE = { lat: 25.0987, lng: 55.2019 };

describe('proof of delivery', () => {
  let t: TestApp;
  let dispatcher: Api;
  let driver: TestDriver;
  let delivery: DeliveryDto;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetState(t.db, t.redis);
    dispatcher = await new Api(t.url).login();
    driver = await enrolDriver(dispatcher, 'Omar Haddad');
    await moveTo(driver, 25.1425, 55.2275);
    delivery = await createDelivery(dispatcher, { autoAssign: true });
    await driver.api.post(`/v1/driver/deliveries/${delivery.id}/pickup`);
  });

  /** Photo files stored for a delivery (PhotoStorage keeps one folder per delivery). */
  const photosOf = (deliveryId: string): Promise<string[]> =>
    readdir(join(t.config.uploads.dir, deliveryId)).catch(() => []);

  const complete = (form: FormData, key?: string) =>
    fetch(`${t.url}/v1/driver/deliveries/${delivery.id}/complete`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${driver.api.token ?? ''}`,
        ...(key && { 'idempotency-key': key }),
      },
      body: form,
    });

  it('completes inside the geofence, stores the proof and queues delivery.completed', async () => {
    const res = await complete(proofForm(AT_THE_GATE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as DeliveryDto;
    expect(body.status).toBe('delivered');
    expect(body.proof).toMatchObject({
      recipientName: 'Aisha Rahman',
      withinGeofence: true,
      hasPhoto: true,
    });
    expect(body.proof?.distanceMeters).toBeGreaterThan(95);
    expect(body.proof?.distanceMeters).toBeLessThan(105);

    const photo = await fetch(`${t.url}/v1/deliveries/${delivery.id}/proof/photo`, {
      headers: { authorization: `Bearer ${dispatcher.token ?? ''}` },
    });
    expect(photo.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await photo.arrayBuffer()).equals(PNG_1X1)).toBe(true);

    const [event] = await t.db.query<{ payload: WebhookEnvelope }>(
      `SELECT payload FROM outbox WHERE delivery_id = $1 AND type = 'delivery.completed'`,
      [delivery.id],
    );
    expect(event?.payload.data).toMatchObject({
      orderReference: delivery.orderReference,
      status: 'delivered',
      proof: { withinGeofence: true, hasPhoto: true, hasSignature: true },
    });
    const detail = (await dispatcher.get<DeliveryDetailDto>(`/v1/deliveries/${delivery.id}`)).body;
    expect(detail.events.at(-1)?.note).toMatch(
      /^Signed by Aisha Rahman, 1\d\d m from the drop-off point$/,
    );
  });

  it('refuses proof captured outside the geofence and keeps the delivery open', async () => {
    const res = await complete(proofForm(DOWN_THE_ROAD, 50));
    expect(res.status).toBe(422);
    const error = (await res.json()) as { code: string; message: string };
    expect(error.code).toBe('GEOFENCE_VIOLATION');
    expect(error.message).toMatch(
      /^You are 2\d\d m from the drop-off point\. Proof of delivery must be captured within 200 m of it\.$/,
    );
    expect((await dispatcher.get<DeliveryDto>(`/v1/deliveries/${delivery.id}`)).body.status).toBe(
      'picked_up',
    );
    const files = await t.db.query('SELECT 1 FROM proofs_of_delivery');
    expect(files).toHaveLength(0);
  });

  it('widens the fence by the reported GPS accuracy, up to the allowance', async () => {
    expect((await complete(proofForm(NEAR_THE_EDGE, 5))).status).toBe(422);
    expect((await complete(proofForm(NEAR_THE_EDGE, 30))).status).toBe(200);
  });

  it('accepts the exact drop-off point', async () => {
    expect((await complete(proofForm(DROPOFF))).status).toBe(200);
  });

  it('checks the photo by its content and requires the signature', async () => {
    const notAnImage = proofForm(AT_THE_GATE, 5, Buffer.from('%PDF-1.7 not a photo'));
    const unsupported = await complete(notAnImage);
    expect(unsupported.status).toBe(415);

    const noPhoto = new FormData();
    noPhoto.set('proof', proofForm(AT_THE_GATE).get('proof'));
    expect((await complete(noPhoto)).status).toBe(400);

    const noSignature = proofForm(AT_THE_GATE);
    const proof = JSON.parse(noSignature.get('proof') as string) as Record<string, unknown>;
    delete proof.signature;
    noSignature.set('proof', JSON.stringify(proof));
    const invalid = await complete(noSignature);
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { details: { path: string }[] }).details[0]?.path).toBe(
      'proof.signature',
    );
  });

  it('answers a retried completion with the same result instead of an error', async () => {
    const first = await complete(proofForm(AT_THE_GATE), 'pod-7c1f0a2e-retry');
    expect(first.status).toBe(200);
    const retry = await complete(proofForm(AT_THE_GATE), 'pod-7c1f0a2e-retry');
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as DeliveryDto).status).toBe('delivered');
    const other = await complete(proofForm(AT_THE_GATE), 'pod-different-key-01');
    expect(other.status).toBe(409);
    const events = await t.db.query(`SELECT 1 FROM outbox WHERE type = 'delivery.completed'`);
    expect(events).toHaveLength(1);
  });

  it('answers two concurrent retries with the same key alike, and keeps one photo', async () => {
    const key = 'pod-concurrent-0001';
    const [first, second] = await Promise.all([
      complete(proofForm(AT_THE_GATE), key),
      complete(proofForm(AT_THE_GATE), key),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const events = await t.db.query(`SELECT 1 FROM outbox WHERE type = 'delivery.completed'`);
    expect(events).toHaveLength(1);
    expect(await photosOf(delivery.id)).toHaveLength(1);
  });

  it('refuses a malformed Idempotency-Key instead of ignoring it', async () => {
    const res = await complete(proofForm(AT_THE_GATE), 'short');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/Idempotency-Key/);
    expect((await dispatcher.get<DeliveryDto>(`/v1/deliveries/${delivery.id}`)).body.status).toBe(
      'picked_up',
    );
  });

  it("writes nothing to disk for another driver's delivery", async () => {
    const other = await enrolDriver(dispatcher, 'Other Driver');
    const res = await fetch(`${t.url}/v1/driver/deliveries/${delivery.id}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${other.api.token ?? ''}` },
      body: proofForm(AT_THE_GATE),
    });
    expect(res.status).toBe(403);
    expect(await photosOf(delivery.id)).toEqual([]);
  });

  it('refuses a photo above MAX_PHOTO_BYTES with 413', async () => {
    const big = Buffer.concat([PNG_1X1, Buffer.alloc(t.config.uploads.maxPhotoBytes)]);
    const res = await complete(proofForm(AT_THE_GATE, 6, big));
    expect(res.status).toBe(413);
    expect(await photosOf(delivery.id)).toEqual([]);
  });

  it('does not complete a delivery that was never picked up', async () => {
    const second = await enrolDriver(dispatcher, 'Second Driver');
    await moveTo(second, 25.1425, 55.2275);
    const fresh = await createDelivery(dispatcher, { autoAssign: true });
    const res = await fetch(`${t.url}/v1/driver/deliveries/${fresh.id}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${second.api.token ?? ''}` },
      body: proofForm(AT_THE_GATE),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('INVALID_TRANSITION');
  });
});
