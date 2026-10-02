import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { InjectConfig } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { Database } from '../db/database.js';
import { RedisService } from '../redis/redis.service.js';
import {
  MAINTENANCE_QUEUE,
  OutboxQueue,
  QUEUE_PREFIX,
  WEBHOOK_QUEUE,
  type WebhookJob,
} from './outbox.queue.js';
import { OutboxRepository } from './outbox.repository.js';
import { WebhookSender } from './webhook-sender.js';

/** Enqueued rows still pending after this long are handed to the queue again. */
const STUCK_AFTER_S = 600;
const SWEEP_EVERY_MS = 5_000;
const PRUNE_EVERY_MS = 3_600_000;
const PRUNE_BATCH = 5_000;

/**
 * The relay: delivers outbox rows as signed webhooks, with BullMQ handling retries and
 * exponential backoff. Also runs two scheduled jobs: the outbox sweep (enqueues rows the API
 * could not enqueue itself) and pruning of old location history. Only runs in worker processes.
 */
@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);
  private webhookWorker?: Worker<WebhookJob>;
  private maintenanceWorker?: Worker;
  private maintenanceQueue?: Queue;

  constructor(
    private readonly redis: RedisService,
    private readonly db: Database,
    private readonly outbox: OutboxRepository,
    private readonly queue: OutboxQueue,
    private readonly sender: WebhookSender,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const workerConnection = { maxRetriesPerRequest: null };
    if (this.sender.enabled) {
      this.webhookWorker = new Worker<WebhookJob>(WEBHOOK_QUEUE, (job) => this.deliver(job), {
        connection: this.redis.create('bullmq-webhook-worker', workerConnection),
        prefix: QUEUE_PREFIX,
        concurrency: 8,
      });
      this.webhookWorker.on('failed', (job, error) => {
        if (!job) return;
        const final =
          job.attemptsMade >= (job.opts.attempts ?? 1) || error instanceof UnrecoverableError;
        if (final) {
          void this.outbox.markFailed(job.data.outboxId, error.message).catch(() => undefined);
          this.logger.warn(`Webhook ${job.data.outboxId} failed permanently: ${error.message}`);
        }
      });
      this.webhookWorker.on('error', (error) => {
        this.logger.warn(`Webhook worker: ${error.message}`);
      });
    } else {
      this.logger.warn('WEBHOOK_URL is not set: events are kept in the outbox and not delivered');
    }

    const maintenance = new Queue(MAINTENANCE_QUEUE, {
      connection: this.redis.create('bullmq-maintenance'),
      prefix: QUEUE_PREFIX,
    });
    this.maintenanceQueue = maintenance;
    // Job schedulers are stored in Redis: however many workers run, each tick runs once.
    await maintenance.upsertJobScheduler(
      'outbox-sweep',
      { every: SWEEP_EVERY_MS },
      {
        name: 'outbox-sweep',
        opts: { removeOnComplete: true, removeOnFail: 100 },
      },
    );
    await maintenance.upsertJobScheduler(
      'prune-locations',
      { every: PRUNE_EVERY_MS },
      {
        name: 'prune-locations',
        opts: { removeOnComplete: true, removeOnFail: 100 },
      },
    );
    this.maintenanceWorker = new Worker(
      MAINTENANCE_QUEUE,
      (job: Job) => (job.name === 'outbox-sweep' ? this.sweep() : this.pruneLocations()),
      {
        connection: this.redis.create('bullmq-maintenance-worker', workerConnection),
        prefix: QUEUE_PREFIX,
        concurrency: 1,
      },
    );
    this.maintenanceWorker.on('error', (error) => {
      this.logger.warn(`Maintenance worker: ${error.message}`);
    });
    this.logger.log('Worker started: webhook relay, outbox sweep and location pruning');
  }

  /** Delivers one event. Throwing makes BullMQ retry with backoff; UnrecoverableError stops. */
  async deliver(job: Job<WebhookJob>): Promise<string> {
    const row = await this.outbox.find(job.data.outboxId);
    if (!row || row.delivered_at || row.failed_at) return 'skipped';
    const outcome = await this.sender.send(row.payload);
    const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (outcome.kind === 'delivered') {
      await this.outbox.recordAttempt(row.id, {
        status: outcome.status,
        error: null,
        delivered: true,
        failed: false,
      });
      return 'delivered';
    }
    const rejected = outcome.kind === 'rejected';
    await this.outbox.recordAttempt(row.id, {
      status: outcome.status,
      error: outcome.error,
      delivered: false,
      failed: rejected || lastAttempt,
    });
    if (rejected) throw new UnrecoverableError(outcome.error);
    throw new Error(outcome.error);
  }

  /** Enqueues pending rows the API did not manage to enqueue (or that got stuck). */
  async sweep(): Promise<number> {
    if (!this.queue.enabled) return 0;
    const ids = await this.outbox.claimForEnqueue(200, STUCK_AFTER_S);
    await this.queue.enqueue(ids);
    return ids.length;
  }

  /** Deletes location history older than LOCATION_HISTORY_DAYS, in small batches. */
  async pruneLocations(): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.db.query<{ n: number }>(
        `WITH doomed AS (
           SELECT ctid FROM location_updates
            WHERE received_at < now() - make_interval(days => $1)
            LIMIT $2)
         DELETE FROM location_updates WHERE ctid IN (SELECT ctid FROM doomed)
         RETURNING 1 AS n`,
        [this.config.locations.historyDays, PRUNE_BATCH],
      );
      total += deleted.length;
      if (deleted.length < PRUNE_BATCH) return total;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([
      this.webhookWorker?.close(),
      this.maintenanceWorker?.close(),
      this.maintenanceQueue?.close(),
    ]);
  }
}
