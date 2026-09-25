import type { OutboxEntryDto, WebhookEnvelope } from '@dispatch/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxQueue } from '../../src/outbox/outbox.queue.js';
import { OutboxWorker } from '../../src/outbox/outbox.worker.js';
import { verifyWebhook } from '../../src/outbox/webhook-signature.js';
import {
  Api,
  WebhookSink,
  createDelivery,
  enrolDriver,
  eventually,
  moveTo,
  resetState,
  startApp,
  type TestApp,
} from '../support/harness.js';

const SECRET = 'relay-test-secret-relay-test-secret-000000';

interface OutboxState {
  attempts: number;
  delivered_at: Date | null;
  failed_at: Date | null;
  last_status: number | null;
}

describe('webhook relay (transactional outbox + BullMQ)', () => {
  const sink = new WebhookSink();
  let t: TestApp;
  let dispatcher: Api;

  beforeAll(async () => {
    const url = await sink.start();
    t = await startApp({ WEBHOOK_URL: url, WEBHOOK_SECRET: SECRET }, { worker: true });
  });
  afterAll(async () => {
    await t.close();
    await sink.stop();
  });
  beforeEach(async () => {
    await resetState(t.db, t.redis);
    dispatcher = await new Api(t.url).login();
    sink.received.length = 0;
    sink.respondWith();
  });
  afterEach(async () => {
    // Let in-flight jobs settle before the next test truncates their rows.
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  const outboxRow = (id: string) =>
    t.db.one<OutboxState>(
      'SELECT attempts, delivered_at, failed_at, last_status FROM outbox WHERE id = $1',
      [id],
    );

  async function assignedDelivery(): Promise<{ eventId: string; deliveryId: string }> {
    const driver = await enrolDriver(dispatcher, `Driver ${String(Date.now())}`);
    await moveTo(driver, 25.1425, 55.2275);
    const delivery = await createDelivery(dispatcher, { autoAssign: true });
    const row = await t.db.one<{ id: string }>(
      `SELECT id FROM outbox WHERE delivery_id = $1 AND type = 'delivery.assigned'`,
      [delivery.id],
    );
    return { eventId: row.id, deliveryId: delivery.id };
  }

  it('delivers a signed event that the receiver can verify', async () => {
    const { eventId, deliveryId } = await assignedDelivery();
    const received = await eventually(() =>
      sink.received.find((r) => r.headers['x-dispatch-event-id'] === eventId),
    );

    expect(received.headers['x-dispatch-event-type']).toBe('delivery.assigned');
    const check = verifyWebhook(
      SECRET,
      received.body,
      received.headers['x-dispatch-signature'] as string,
    );
    expect(check.valid).toBe(true);
    expect(
      verifyWebhook(
        'another-secret-another-secret-another',
        received.body,
        received.headers['x-dispatch-signature'] as string,
      ),
    ).toEqual({
      valid: false,
      reason: 'mismatch',
    });

    const envelope = JSON.parse(received.body) as WebhookEnvelope;
    expect(envelope).toMatchObject({
      id: eventId,
      type: 'delivery.assigned',
      data: { deliveryId, status: 'assigned' },
    });
    expect(envelope.data.trackingUrl).toMatch(/^http:\/\/localhost:57300\/track\/v1\./);
    const row = await eventually(async () => {
      const r = await outboxRow(eventId);
      return r.delivered_at ? r : undefined;
    });
    expect(row).toMatchObject({ attempts: 1, last_status: 200, failed_at: null });
  });

  it('retries with backoff after server errors, then succeeds once', async () => {
    sink.respondWith(503, 500);
    const { eventId } = await assignedDelivery();
    const row = await eventually(async () => {
      const r = await outboxRow(eventId);
      return r.delivered_at ? r : undefined;
    });
    expect(row.attempts).toBe(3);
    const deliveries = sink.received.filter((r) => r.headers['x-dispatch-event-id'] === eventId);
    expect(deliveries).toHaveLength(3);
    // Every attempt is signed afresh with its own timestamp.
    for (const attempt of deliveries) {
      expect(
        verifyWebhook(SECRET, attempt.body, attempt.headers['x-dispatch-signature'] as string)
          .valid,
      ).toBe(true);
    }
  });

  it('stops at once when the receiver rejects the event, and can be sent again by hand', async () => {
    sink.respondWith(422);
    const { eventId } = await assignedDelivery();
    const failed = await eventually(async () => {
      const r = await outboxRow(eventId);
      return r.failed_at ? r : undefined;
    });
    expect(failed).toMatchObject({ attempts: 1, last_status: 422, delivered_at: null });

    const listed = (await dispatcher.get<OutboxEntryDto[]>('/v1/webhooks?state=failed')).body;
    expect(listed.map((e) => e.id)).toContain(eventId);

    const retried = await dispatcher.post<OutboxEntryDto>(`/v1/webhooks/${eventId}/retry`);
    expect(retried.status).toBe(202);
    const delivered = await eventually(async () => {
      const r = await outboxRow(eventId);
      return r.delivered_at ? r : undefined;
    });
    expect(delivered.attempts).toBe(2);
    expect((await dispatcher.post(`/v1/webhooks/${eventId}/retry`)).status).toBe(409);
  });

  it('gives up after the configured number of attempts', async () => {
    sink.respondWith(500, 500, 500, 500);
    const { eventId } = await assignedDelivery();
    const failed = await eventually(async () => {
      const r = await outboxRow(eventId);
      return r.failed_at ? r : undefined;
    });
    expect(failed.attempts).toBe(3);
  });

  it('enqueues through the sweeper when the API could not, and never sends twice', async () => {
    const { eventId } = await assignedDelivery();
    await eventually(async () => ((await outboxRow(eventId)).delivered_at ? true : undefined));
    // Enqueuing the same event again (the fast path racing the sweeper) is a no-op.
    await t.app.get(OutboxQueue).enqueue([eventId]);
    const worker = t.worker?.get(OutboxWorker);
    await worker?.sweep();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(sink.received.filter((r) => r.headers['x-dispatch-event-id'] === eventId)).toHaveLength(
      1,
    );

    // A row whose enqueue was lost (the API crashed after the commit) is picked up by a sweep.
    const orphan = await t.db.one<{ id: string }>(
      `WITH n AS (SELECT gen_random_uuid() AS id)
       INSERT INTO outbox (id, delivery_id, type, payload)
       SELECT n.id, o.delivery_id, o.type, jsonb_set(o.payload, '{id}', to_jsonb(n.id::text))
         FROM outbox o, n WHERE o.id = $1
       RETURNING id`,
      [eventId],
    );
    await worker?.sweep();
    await eventually(async () => ((await outboxRow(orphan.id)).delivered_at ? true : undefined));
    expect(
      sink.received.filter((r) => r.headers['x-dispatch-event-id'] === orphan.id),
    ).toHaveLength(1);
  });
});
