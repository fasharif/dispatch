import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { ENROLMENT_CODE_ALPHABET, ENROLMENT_CODE_LENGTH } from '@dispatch/shared';
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';
import { InjectConfig } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import type { DispatcherPrincipal } from '../common/request-context.js';

const ISSUER = 'dispatch-api';
const AUDIENCE = 'dispatch-console';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A device bearer token: 256 random bits. Only its SHA-256 hash is stored. */
export function newDeviceToken(): string {
  return `dvc_${randomBytes(32).toString('base64url')}`;
}

/** An 8-character enrolment code from an unambiguous alphabet (about 40 bits). */
export function newEnrolmentCode(): string {
  let code = '';
  for (let i = 0; i < ENROLMENT_CODE_LENGTH; i += 1) {
    code += ENROLMENT_CODE_ALPHABET.charAt(randomInt(ENROLMENT_CODE_ALPHABET.length));
  }
  return code;
}

export class InvalidAccessToken extends Error {}

/** Short-lived HS256 access tokens for dispatchers (the web console keeps them in memory). */
@Injectable()
export class AccessTokens {
  private readonly key: Uint8Array;

  constructor(@InjectConfig() private readonly config: AppConfig) {
    this.key = new TextEncoder().encode(config.auth.jwtSecret);
  }

  async issue(dispatcher: DispatcherPrincipal): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.config.auth.jwtTtlMinutes * 60_000);
    const token = await new SignJWT({ email: dispatcher.email, name: dispatcher.name })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(dispatcher.id)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.key);
    return { token, expiresAt };
  }

  async verify(token: string): Promise<DispatcherPrincipal> {
    return (await this.verifySession(token)).dispatcher;
  }

  /** Verifies a token and also says when it expires (live connections close at that moment). */
  async verifySession(
    token: string,
  ): Promise<{ dispatcher: DispatcherPrincipal; expiresAt: Date }> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.email !== 'string' ||
        typeof payload.name !== 'string' ||
        typeof payload.exp !== 'number'
      ) {
        throw new InvalidAccessToken('Token is missing claims');
      }
      return {
        dispatcher: {
          kind: 'dispatcher',
          id: payload.sub,
          email: payload.email,
          name: payload.name,
        },
        expiresAt: new Date(payload.exp * 1000),
      };
    } catch (error) {
      if (error instanceof InvalidAccessToken) throw error;
      if (error instanceof joseErrors.JOSEError) throw new InvalidAccessToken(error.code);
      throw error;
    }
  }
}
