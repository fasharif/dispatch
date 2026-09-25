import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AppRequest } from '../common/request-context.js';
import { ACCESS_POLICY, bearerToken, type AccessPolicy } from './auth.decorators.js';
import { DeviceTokens } from './device-tokens.js';
import { AccessTokens, InvalidAccessToken } from './tokens.js';

/** Resolves the caller from the Authorization header according to the route's access policy. */
@Injectable()
export class AccessGuard implements CanActivate {
  private readonly logger = new Logger(AccessGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokens,
    private readonly devices: DeviceTokens,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const policy = this.reflector.getAllAndOverride<AccessPolicy | undefined>(ACCESS_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<AppRequest>();

    if (policy === 'public') return true;
    if (policy === undefined) {
      this.logger.error(`${request.method} ${request.path} has no access policy`);
      throw new ForbiddenException();
    }

    const token = bearerToken(request.get('authorization'));
    if (!token) throw new UnauthorizedException('Sign in first: this request needs a bearer token');

    if (policy === 'dispatcher') {
      try {
        request.principal = await this.tokens.verify(token);
      } catch (error) {
        if (error instanceof InvalidAccessToken) {
          throw new UnauthorizedException('Your session has expired or is invalid. Sign in again.');
        }
        throw error;
      }
      return true;
    }

    const device = await this.devices.resolve(token);
    if (!device) {
      throw new UnauthorizedException('This device is not enrolled or has been revoked');
    }
    request.principal = device;
    return true;
  }
}
