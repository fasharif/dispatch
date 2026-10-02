import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { LoginInput, LoginResult } from '@dispatch/shared';
import { Database } from '../db/database.js';
import { dummyPasswordHash, verifyPassword } from './passwords.js';
import { AccessTokens } from './tokens.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly tokens: AccessTokens,
  ) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const row = await this.db.maybeOne<{
      id: string;
      email: string;
      name: string;
      password_hash: string;
    }>('SELECT id, email, name, password_hash FROM dispatchers WHERE email = $1', [input.email]);
    // Always run one scrypt verification, so unknown and known emails take the same time.
    const valid = await verifyPassword(
      input.password,
      row?.password_hash ?? (await dummyPasswordHash()),
    );
    if (!row || !valid) throw new UnauthorizedException('Email or password is incorrect');

    const dispatcher = {
      kind: 'dispatcher' as const,
      id: row.id,
      email: row.email,
      name: row.name,
    };
    const { token, expiresAt } = await this.tokens.issue(dispatcher);
    return {
      accessToken: token,
      expiresAt: expiresAt.toISOString(),
      dispatcher: { id: row.id, email: row.email, name: row.name },
    };
  }
}
