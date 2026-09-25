import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { outboxStateSchema, type OutboxEntryDto } from '@dispatch/shared';
import { z } from 'zod';
import { Access } from '../auth/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { OutboxQueue } from './outbox.queue.js';
import { OutboxRepository, toOutboxEntryDto } from './outbox.repository.js';

const listQuerySchema = z.object({
  state: outboxStateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** The outbox as dispatchers see it: what was sent to the order system, and what failed. */
@Controller('v1/webhooks')
@Access('dispatcher')
export class WebhooksController {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly queue: OutboxQueue,
  ) {}

  @Get()
  async list(
    @Query(new ZodPipe(listQuerySchema)) query: z.output<typeof listQuerySchema>,
  ): Promise<OutboxEntryDto[]> {
    return (await this.outbox.list(query.state, query.limit)).map(toOutboxEntryDto);
  }

  /** Sends a failed event again, for example after the receiver fixed its configuration. */
  @Post(':id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  async retry(@Param('id', new ParseUUIDPipe()) id: string): Promise<OutboxEntryDto> {
    const row = await this.outbox.reopen(id);
    if (!row) throw new ConflictException('Only failed events can be sent again');
    await this.queue.requeue(id);
    return toOutboxEntryDto(row);
  }
}
