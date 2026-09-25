import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  DeliveryWebhookData,
  OutboxEntryDto,
  OutboxState,
  WebhookEnvelope,
  WebhookEventType,
} from '@dispatch/shared';
import { Database, type Queryable, rows } from '../db/database.js';

export interface OutboxRow {
  id: string;
  delivery_id: string;
  type: WebhookEventType;
  payload: WebhookEnvelope;
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  created_at: Date;
  delivered_at: Date | null;
  failed_at: Date | null;
}

export function toOutboxEntryDto(row: OutboxRow): OutboxEntryDto {
  return {
    id: row.id,
    type: row.type,
    deliveryId: row.delivery_id,
    state: row.delivered_at ? 'delivered' : row.failed_at ? 'failed' : 'pending',
    attempts: row.attempts,
    lastStatus: row.last_status,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    deliveredAt: row.delivered_at?.toISOString() ?? null,
    failedAt: row.failed_at?.toISOString() ?? null,
  };
}

@Injectable()
export class OutboxRepository {
  constructor(private readonly db: Database) {}

  /**
   * Records an event inside the caller's transaction. It commits or rolls back with the change
   * it describes, so a webhook is never sent for a change that did not happen, and never lost
   * for one that did.
   */
  async add(client: Queryable, type: WebhookEventType, data: DeliveryWebhookData): Promise<string> {
    const envelope: WebhookEnvelope = {
      id: randomUUID(),
      type,
      createdAt: new Date().toISOString(),
      data,
    };
    await client.query(
      'INSERT INTO outbox (id, delivery_id, type, payload) VALUES ($1, $2, $3, $4)',
      [envelope.id, data.deliveryId, type, JSON.stringify(envelope)],
    );
    return envelope.id;
  }

  find(id: string): Promise<OutboxRow | null> {
    return this.db.maybeOne<OutboxRow>('SELECT * FROM outbox WHERE id = $1', [id]);
  }

  list(state: OutboxState | undefined, limit: number): Promise<OutboxRow[]> {
    const where =
      state === 'delivered'
        ? 'WHERE delivered_at IS NOT NULL'
        : state === 'failed'
          ? 'WHERE failed_at IS NOT NULL'
          : state === 'pending'
            ? 'WHERE delivered_at IS NULL AND failed_at IS NULL'
            : '';
    return this.db.query<OutboxRow>(
      `SELECT * FROM outbox ${where} ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
  }

  /** Pending events not handed to the queue yet, or handed over long ago and still pending. */
  async claimForEnqueue(limit: number, stuckAfterSeconds: number): Promise<string[]> {
    const claimed = await rows<{ id: string }>(
      this.db.pool,
      `UPDATE outbox SET enqueued_at = now()
        WHERE id IN (
          SELECT id FROM outbox
           WHERE delivered_at IS NULL AND failed_at IS NULL
             AND (enqueued_at IS NULL OR enqueued_at < now() - make_interval(secs => $2))
           ORDER BY created_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED)
        RETURNING id`,
      [limit, stuckAfterSeconds],
    );
    return claimed.map((row) => row.id);
  }

  markEnqueued(ids: readonly string[]): Promise<unknown> {
    return this.db.query('UPDATE outbox SET enqueued_at = now() WHERE id = ANY($1::uuid[])', [ids]);
  }

  recordAttempt(
    id: string,
    outcome: { status: number | null; error: string | null; delivered: boolean; failed: boolean },
  ): Promise<unknown> {
    return this.db.query(
      `UPDATE outbox
          SET attempts = attempts + 1, last_attempt_at = now(), last_status = $2, last_error = $3,
              delivered_at = CASE WHEN $4 THEN now() ELSE delivered_at END,
              failed_at = CASE WHEN $5 AND NOT $4 THEN now() ELSE failed_at END
        WHERE id = $1`,
      [id, outcome.status, outcome.error, outcome.delivered, outcome.failed],
    );
  }

  markFailed(id: string, error: string): Promise<unknown> {
    return this.db.query(
      `UPDATE outbox SET failed_at = now(), last_error = COALESCE($2, last_error)
        WHERE id = $1 AND delivered_at IS NULL`,
      [id, error],
    );
  }

  /** Puts a failed event back in the queue (manual replay from the console). */
  async reopen(id: string): Promise<OutboxRow | null> {
    const [row] = await this.db.query<OutboxRow>(
      `UPDATE outbox SET failed_at = NULL, enqueued_at = now()
        WHERE id = $1 AND failed_at IS NOT NULL
        RETURNING *`,
      [id],
    );
    return row ?? null;
  }
}
