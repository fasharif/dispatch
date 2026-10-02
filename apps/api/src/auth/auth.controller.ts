import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  loginSchema,
  type DispatcherDto,
  type LoginInput,
  type LoginResult,
} from '@dispatch/shared';
import type { DispatcherPrincipal } from '../common/request-context.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { strictThrottle } from '../common/throttle.js';
import { Access, CurrentDispatcher } from './auth.decorators.js';
import { AuthService } from './auth.service.js';

@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Access('public')
  @Throttle(strictThrottle)
  login(@Body(new ZodPipe(loginSchema)) input: LoginInput): Promise<LoginResult> {
    return this.auth.login(input);
  }

  @Get('me')
  @Access('dispatcher')
  me(@CurrentDispatcher() dispatcher: DispatcherPrincipal): DispatcherDto {
    return { id: dispatcher.id, email: dispatcher.email, name: dispatcher.name };
  }
}
