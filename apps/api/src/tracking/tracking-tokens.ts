import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { InjectConfig } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';

const VERSION = 'v1';
const payloadSchema = z.object({ d: z.uuid(), e: z.int().positive() });

export type TrackingTokenResult =
  | { status: 'valid'; deliveryId: string; expiresAt: Date }
  | { status: 'expired'; deliveryId: string; expiresAt: Date }
  | { status: 'invalid' };

/**
 * Customer tracking links: `v1.<payload>.<signature>`, where the payload is base64url JSON
 * `{ d: deliveryId, e: expiry (Unix seconds) }` and the signature is HMAC-SHA256 over
 * "v1.<payload>" with TRACKING_TOKEN_SECRET.
 *
 * The link carries no personal data and cannot be forged or extended without the secret.
 * Rotating the secret invalidates every link issued with the old one.
 */
@Injectable()
export class TrackingTokens {
  private readonly secret: string;

  constructor(@InjectConfig() config: AppConfig) {
    this.secret = config.tracking.secret;
  }

  sign(deliveryId: string, expiresAt: Date): string {
    const payload = Buffer.from(
      JSON.stringify({ d: deliveryId, e: Math.floor(expiresAt.getTime() / 1000) }),
    ).toString('base64url');
    return `${VERSION}.${payload}.${this.mac(`${VERSION}.${payload}`).toString('base64url')}`;
  }

  verify(token: string, now: Date = new Date()): TrackingTokenResult {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== VERSION) return { status: 'invalid' };
    const [, payload = '', signature = ''] = parts;
    const expected = this.mac(`${VERSION}.${payload}`);
    const presented = Buffer.from(signature, 'base64url');
    // Compare in constant time; lengths are public (always 32 bytes for a genuine token).
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      return { status: 'invalid' };
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return { status: 'invalid' };
    }
    const parsed = payloadSchema.safeParse(decoded);
    if (!parsed.success) return { status: 'invalid' };
    const expiresAt = new Date(parsed.data.e * 1000);
    return expiresAt.getTime() <= now.getTime()
      ? { status: 'expired', deliveryId: parsed.data.d, expiresAt }
      : { status: 'valid', deliveryId: parsed.data.d, expiresAt };
  }

  private mac(data: string): Buffer {
    return createHmac('sha256', this.secret).update(data).digest();
  }
}
