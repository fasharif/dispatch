import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signatures, in the format documented for receivers:
 *
 *   x-dispatch-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * The timestamp is signed with the body, so a captured request cannot be replayed later than
 * the receiver's tolerance, and the body cannot be altered without the secret.
 */
export function signWebhook(secret: string, rawBody: string, timestampSeconds: number): string {
  const t = String(Math.floor(timestampSeconds));
  const v1 = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

export type SignatureCheck =
  | { valid: true; timestamp: number }
  | { valid: false; reason: 'malformed' | 'expired' | 'mismatch' };

/**
 * Reference verification, as a receiver should do it: parse, check the timestamp tolerance,
 * then compare every v1 value in constant time. Used by the tests and the local webhook sink.
 */
export function verifyWebhook(
  secret: string,
  rawBody: string,
  header: string | undefined,
  toleranceSeconds = 300,
  nowSeconds: number = Date.now() / 1000,
): SignatureCheck {
  if (!header) return { valid: false, reason: 'malformed' };
  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && value && /^[0-9a-f]{64}$/.test(value)) candidates.push(value);
  }
  if (timestamp === null || candidates.length === 0) return { valid: false, reason: 'malformed' };
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds)
    return { valid: false, reason: 'expired' };
  const expected = createHmac('sha256', secret)
    .update(`${String(timestamp)}.${rawBody}`)
    .digest();
  const matches = candidates.some((candidate) =>
    timingSafeEqual(Buffer.from(candidate, 'hex'), expected),
  );
  return matches ? { valid: true, timestamp } : { valid: false, reason: 'mismatch' };
}
