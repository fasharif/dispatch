import type { WebhookEnvelope } from '@dispatch/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/env.js';
import { localServer, type LocalServer } from '../../test/support/local-server.js';
import { WebhookSender, classifyStatus } from './webhook-sender.js';
import { verifyWebhook } from './webhook-signature.js';

const SECRET = 'sender-unit-test-secret-sender-unit-test';
const envelope: WebhookEnvelope = {
  id: '6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b',
  type: 'delivery.completed',
  createdAt: '2026-09-20T10:00:00.000Z',
  data: {
    deliveryId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    orderReference: 'TF-SO-2026-000123',
    status: 'delivered',
    occurredAt: '2026-09-20T10:00:00.000Z',
    driver: null,
  },
};

function sender(url: string, timeoutMs = 2000): WebhookSender {
  return new WebhookSender(
    loadConfig({
      DATABASE_URL: 'postgresql://localhost/dispatch',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'j'.repeat(40),
      TRACKING_TOKEN_SECRET: 't'.repeat(40),
      WEBHOOK_URL: url,
      WEBHOOK_SECRET: SECRET,
      WEBHOOK_TIMEOUT_MS: String(timeoutMs),
    }),
  );
}

describe('classifyStatus', () => {
  it('treats 2xx as delivered, 5xx and throttling as retryable, other 4xx as final', () => {
    expect([200, 201, 202, 204].map(classifyStatus)).toEqual([
      'delivered',
      'delivered',
      'delivered',
      'delivered',
    ]);
    expect([500, 502, 503, 408, 409, 425, 429].map(classifyStatus)).toEqual(Array(7).fill('retry'));
    expect([400, 401, 403, 404, 410, 422].map(classifyStatus)).toEqual(Array(6).fill('rejected'));
    expect(classifyStatus(301)).toBe('rejected');
  });
});

describe('WebhookSender', () => {
  let server: LocalServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('posts the envelope with id, type and a verifiable signature', async () => {
    server = await localServer((_req, res) => {
      res.statusCode = 202;
      res.end();
    });
    const outcome = await sender(`${server.url}/hook`).send(envelope);
    expect(outcome).toEqual({ kind: 'delivered', status: 202 });
    const [request] = server.requests;
    expect(request?.headers['x-dispatch-event-id']).toBe(envelope.id);
    expect(request?.headers['x-dispatch-event-type']).toBe('delivery.completed');
    expect(request?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request?.body ?? '{}')).toEqual(envelope);
    expect(
      verifyWebhook(SECRET, request?.body ?? '', request?.headers['x-dispatch-signature'] as string)
        .valid,
    ).toBe(true);
  });

  it('reports server errors as retryable and 4xx refusals as final, with a snippet of the reply', async () => {
    const statuses = [503, 422];
    server = await localServer((_req, res) => {
      res.statusCode = statuses.shift() ?? 200;
      res.end('{"message":"Order TF-SO-2026-000123 is unknown"}');
    });
    const url = `${server.url}/hook`;
    expect(await sender(url).send(envelope)).toMatchObject({ kind: 'retry', status: 503 });
    const refused = await sender(url).send(envelope);
    expect(refused).toMatchObject({ kind: 'rejected', status: 422 });
    expect(refused.kind === 'rejected' && refused.error).toContain('is unknown');
  });

  it('reads only the start of a reply, so an endless body cannot fill the worker', async () => {
    let written = 0;
    server = await localServer((_req, res) => {
      res.statusCode = 500;
      const chunk = 'x'.repeat(64 * 1024);
      // Writes until the client goes away: reading the whole body would never finish.
      const pump = () => {
        while (!res.destroyed && written < 512 * 1024 * 1024) {
          written += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
      };
      pump();
    });
    const outcome = await sender(`${server.url}/hook`, 10_000).send(envelope);
    expect(outcome).toMatchObject({ kind: 'retry', status: 500 });
    expect(outcome.kind === 'retry' && outcome.error).toBe(`HTTP 500: ${'x'.repeat(300)}`);
    expect(written).toBeLessThan(64 * 1024 * 1024);
  });

  it('turns timeouts and refused connections into retryable outcomes', async () => {
    server = await localServer(() => {
      // Never answers.
    });
    const slow = await sender(`${server.url}/hook`, 500).send(envelope);
    expect(slow).toEqual({ kind: 'retry', status: null, error: 'No response within 500 ms' });

    const refused = await sender('http://127.0.0.1:9/hook').send(envelope);
    expect(refused).toMatchObject({ kind: 'retry', status: null });
  });

  it('treats a redirect as a configuration error: not followed, not retried', async () => {
    server = await localServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://127.0.0.1:9/elsewhere');
      res.end();
    });
    expect(await sender(`${server.url}/hook`).send(envelope)).toMatchObject({
      kind: 'rejected',
      status: 302,
    });
    expect(server.requests).toHaveLength(1);
  });
});
