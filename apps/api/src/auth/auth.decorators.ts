import {
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type {
  AppRequest,
  DevicePrincipal,
  DispatcherPrincipal,
} from '../common/request-context.js';

export const ACCESS_POLICY = 'access:policy';
export type AccessPolicy = 'public' | 'dispatcher' | 'device';

/**
 * Every route declares who may call it. Routes without a policy are refused (deny by default),
 * so a forgotten decorator can never open an endpoint.
 */
export const Access = (policy: AccessPolicy) => SetMetadata(ACCESS_POLICY, policy);

export const CurrentDispatcher = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): DispatcherPrincipal => {
    const principal = ctx.switchToHttp().getRequest<AppRequest>().principal;
    if (principal?.kind !== 'dispatcher') throw new UnauthorizedException();
    return principal;
  },
);

export const CurrentDevice = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): DevicePrincipal => {
    const principal = ctx.switchToHttp().getRequest<AppRequest>().principal;
    if (principal?.kind !== 'device') throw new UnauthorizedException();
    return principal;
  },
);

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}
