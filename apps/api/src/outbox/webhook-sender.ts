import { Injectable } from '@nestjs/common';
import {
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_EVENT_TYPE_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookEnvelope,
} from '@dispatch/shared';
import { InjectConfig } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { signWebhook } from './webhook-signature.js';

export type SendOutcome =
  | { kind: 'delivered'; status: number }
  /** Worth another attempt later: network errors, timeouts, 5xx, 408, 409, 425, 429. */
  | { kind: 'retry'; status: number | null; error: string }
  /** The receiver refused the event for good (other 4xx); retrying cannot help. */
  | { kind: 'rejected'; status: number; error: string };

const RETRYABLE_4XX = new Set([408, 409, 425, 429]);

/** How much of a reply is read for the log: enough for an error message, never a whole body. */
const SNIPPET_BYTES = 1024;
const SNIPPET_CHARS = 300;

export function classifyStatus(status: number): 'delivered' | 'retry' | 'rejected' {
  if (status >= 200 && status < 300) return 'delivered';
  if (status >= 500 || RETRYABLE_4XX.has(status)) return 'retry';
  return 'rejected';
}

/** Posts one signed webhook. It never throws: every result is an outcome. */
@Injectable()
export class WebhookSender {
  constructor(@InjectConfig() private readonly config: AppConfig) {}

  get enabled(): boolean {
    return Boolean(this.config.webhooks.url && this.config.webhooks.secret);
  }

  async send(envelope: WebhookEnvelope): Promise<SendOutcome> {
    const { url, secret, timeoutMs } = this.config.webhooks;
    if (!url || !secret) return { kind: 'retry', status: null, error: 'WEBHOOK_URL is not set' };
    const body = JSON.stringify(envelope);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'dispatch-webhooks/1',
          [WEBHOOK_EVENT_ID_HEADER]: envelope.id,
          [WEBHOOK_EVENT_TYPE_HEADER]: envelope.type,
          [WEBHOOK_SIGNATURE_HEADER]: signWebhook(secret, body, Date.now() / 1000),
        },
        body,
        // A redirect means WEBHOOK_URL is wrong: it is reported, never followed with the signature.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'TimeoutError'
          ? `No response within ${String(timeoutMs)} ms`
          : error instanceof Error
            ? error.cause instanceof Error
              ? error.cause.message
              : error.message
            : String(error);
      return { kind: 'retry', status: null, error: message };
    }
    // The start of the reply, for the log; a receiver's large or endless body is not read.
    const text = await readSnippet(response);
    const kind = classifyStatus(response.status);
    if (kind === 'delivered') return { kind, status: response.status };
    const error = `HTTP ${String(response.status)}${text ? `: ${text}` : ''}`;
    return kind === 'retry'
      ? { kind, status: response.status, error }
      : { kind, status: response.status, error };
  }
}

/**
 * Reads at most SNIPPET_BYTES of a response body, then cancels the rest, so a misbehaving
 * receiver cannot make the worker buffer a large reply. Returns up to SNIPPET_CHARS characters.
 */
export async function readSnippet(response: Response): Promise<string> {
  // Node's typings leave the chunk type open; fetch bodies are byte streams.
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < SNIPPET_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    // A broken body only costs the snippet.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(Math.min(size, SNIPPET_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.length - offset);
    bytes.set(part, offset);
    offset += part.length;
    if (offset >= bytes.length) break;
  }
  return new TextDecoder().decode(bytes).slice(0, SNIPPET_CHARS);
}
