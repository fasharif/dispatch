import type { WebhookEnvelope } from '@dispatch/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/env.js';
import type { Database } from '../db/database.js';
import type { RedisService } from '../redis/redis.service.js';
import type { OutboxQueue, WebhookJob } from './outbox.queue.js';
import type { OutboxRepository, OutboxRow } from './outbox.repository.js';
import { OutboxWorker } from './outbox.worker.js';
import type { SendOutcome, WebhookSender } from './webhook-sender.js';

type Attempt = Parameters<OutboxRepository['recordAttempt']>[1];

function setup(row: Partial<OutboxRow> | null, outcome: SendOutcome) {
  const attempts: Attempt[] = [];
  const repository = {
    find: () =>
      Promise.resolve(
        row && {
          id: 'e1',
          delivery_id: 'd1',
          type: 'delivery.completed',
          payload: { id: 'e1' } as WebhookEnvelope,
          attempts: 0,
          last_status: null,
          last_error: null,
          created_at: new Date(),
          delivered_at: null,
          failed_at: null,
          ...row,
        },
      ),
    recordAttempt: (_id: string, attempt: Attempt) => {
      attempts.push(attempt);
      return Promise.resolve();
    },
  } as unknown as OutboxRepository;
  const sent: WebhookEnvelope[] = [];
  const sender = {
    send: (envelope: WebhookEnvelope) => {
      sent.push(envelope);
      return Promise.resolve(outcome);
    },
  } as unknown as WebhookSender;
  const worker = new OutboxWorker(
    {} as RedisService,
    {} as Database,
    repository,
    {} as OutboxQueue,
    sender,
    {} as AppConfig,
  );
  return { worker, attempts, sent };
}

const job = (attemptsMade: number, attempts = 3) =>
  ({ data: { outboxId: 'e1' }, attemptsMade, opts: { attempts } }) as unknown as Job<WebhookJob>;

describe('OutboxWorker.deliver', () => {
  it('records a delivered event', async () => {
    const { worker, attempts, sent } = setup({}, { kind: 'delivered', status: 200 });
    expect(await worker.deliver(job(0))).toBe('delivered');
    expect(sent).toHaveLength(1);
    expect(attempts).toEqual([{ status: 200, error: null, delivered: true, failed: false }]);
  });

  it('throws so BullMQ retries, and marks the event failed on the last attempt', async () => {
    const outcome: SendOutcome = { kind: 'retry', status: 503, error: 'HTTP 503' };
    const early = setup({}, outcome);
    await expect(early.worker.deliver(job(0))).rejects.toThrow('HTTP 503');
    expect(early.attempts[0]).toMatchObject({ failed: false });

    const last = setup({}, outcome);
    await expect(last.worker.deliver(job(2))).rejects.toThrow('HTTP 503');
    expect(last.attempts[0]).toMatchObject({ failed: true });
  });

  it('stops retrying when the receiver rejects the event', async () => {
    const { worker, attempts } = setup({}, { kind: 'rejected', status: 422, error: 'HTTP 422' });
    await expect(worker.deliver(job(0))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(attempts[0]).toMatchObject({ status: 422, failed: true, delivered: false });
  });

  it('skips events already delivered, already failed or deleted', async () => {
    for (const row of [{ delivered_at: new Date() }, { failed_at: new Date() }, null]) {
      const { worker, sent } = setup(row, { kind: 'delivered', status: 200 });
      expect(await worker.deliver(job(0))).toBe('skipped');
      expect(sent).toHaveLength(0);
    }
  });
});
