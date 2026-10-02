import { readFileSync } from 'node:fs';

/** One signed webhook request as the relay sent it: the headers TopFlow Hub reads, and the body. */
export interface RecordedRequest {
  headers: Record<string, string>;
  body: string;
}

export interface RecordedWebhooks {
  recordedAt: string;
  secret: string;
  requests: RecordedRequest[];
}

/** The headers that carry the contract; TopFlow Hub reads these and nothing else. */
export const CONTRACT_HEADERS = [
  'x-dispatch-event-id',
  'x-dispatch-event-type',
  'x-dispatch-signature',
] as const;

export const FIXTURE_URL = new URL('../fixtures/webhooks.recorded.json', import.meta.url);

export function readRecordedWebhooks(): RecordedWebhooks {
  return JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as RecordedWebhooks;
}

type Shape = string | Shape[] | { [key: string]: Shape };

/** The structure of a JSON value: object keys and value types, without the values themselves. */
export function jsonShape(value: unknown): Shape {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(jsonShape);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, jsonShape((value as Record<string, unknown>)[key])]),
    );
  }
  return typeof value;
}

/**
 * What a receiver depends on in one request: which contract headers are present, the format of the
 * signature, and the body's field names and types. Two requests of the same event type from the
 * same flow must have the same shape; the values (ids, times, signatures) differ.
 */
export function requestShape(request: RecordedRequest): Shape {
  return {
    headers: CONTRACT_HEADERS.filter((name) => typeof request.headers[name] === 'string'),
    signatureFormat: /^t=\d+,v1=[0-9a-f]{64}$/.test(request.headers['x-dispatch-signature'] ?? '')
      ? 't=<unix seconds>,v1=<hex sha256>'
      : 'unexpected',
    body: jsonShape(JSON.parse(request.body)),
  };
}
