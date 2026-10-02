import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import { InjectConfig } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { RedisService } from '../redis/redis.service.js';
import { OutboxRepository } from './outbox.repository.js';

export const QUEUE_PREFIX = 'dispatch';
export const WEBHOOK_QUEUE = 'webhooks';
export const MAINTENANCE_QUEUE = 'maintenance';

export interface WebhookJob {
  outboxId: string;
}

/**
 * Hands outbox rows to the BullMQ webhook queue. The job id is the event id, so enqueuing the
 * same event twice (the fast path racing the sweeper) creates one job.
 */
@Injectable()
export class OutboxQueue implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxQueue.name);
  readonly queue: Queue<WebhookJob>;
  readonly jobOptions: JobsOptions;
  /** Without WEBHOOK_URL events stay pending in the outbox until it is configured. */
  readonly enabled: boolean;

  constructor(
    redis: RedisService,
    private readonly outbox: OutboxRepository,
    @InjectConfig() config: AppConfig,
  ) {
    this.enabled = Boolean(config.webhooks.url && config.webhooks.secret);
    this.jobOptions = {
      attempts: config.webhooks.maxAttempts,
      // 2 s, 4 s, 8 s … with ±20 % jitter so retries from many events do not arrive together.
      backoff: { type: 'exponential', delay: config.webhooks.backoffMs, jitter: 0.2 },
      removeOnComplete: { age: 24 * 3600, count: 10_000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    };
    this.queue = new Queue<WebhookJob>(WEBHOOK_QUEUE, {
      connection: redis.create('bullmq-webhooks'),
      prefix: QUEUE_PREFIX,
      defaultJobOptions: this.jobOptions,
    });
    this.queue.on('error', (error) => {
      this.logger.warn(`Webhook queue: ${error.message}`);
    });
  }

  async enqueue(ids: readonly string[]): Promise<void> {
    if (ids.length === 0 || !this.enabled) return;
    await this.queue.addBulk(
      ids.map((id) => ({ name: 'deliver', data: { outboxId: id }, opts: { jobId: id } })),
    );
  }

  /**
   * Fast path after a commit. Failures are only logged: the sweeper in the worker picks up any
   * row that was not enqueued, so an event is delayed, never lost.
   */
  enqueueAfterCommit(ids: readonly string[]): void {
    if (ids.length === 0 || !this.enabled) return;
    this.enqueue(ids)
      .then(() => this.outbox.markEnqueued(ids))
      .catch((error: unknown) => {
        this.logger.warn(
          `Could not enqueue webhook(s) ${ids.join(', ')} now; the sweeper will retry: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  /** Replaces a finished job so a manually re-opened event is attempted again. */
  async requeue(id: string): Promise<void> {
    const existing = await this.queue.getJob(id);
    if (existing) await existing.remove().catch(() => undefined);
    await this.enqueue([id]);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
