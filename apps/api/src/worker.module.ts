import { Module } from '@nestjs/common';
import { CoreModule } from './core.module.js';
import { OutboxQueue } from './outbox/outbox.queue.js';
import { OutboxRepository } from './outbox/outbox.repository.js';
import { OutboxWorker } from './outbox/outbox.worker.js';
import { WebhookSender } from './outbox/webhook-sender.js';

/** The background process: webhook relay, outbox sweep and location-history pruning. */
@Module({
  imports: [CoreModule],
  providers: [OutboxRepository, OutboxQueue, WebhookSender, OutboxWorker],
})
export class WorkerModule {}
