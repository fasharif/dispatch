import { Controller, Get, Header, Param } from '@nestjs/common';
import type { TrackingResponse } from '@dispatch/shared';
import { Access } from '../auth/auth.decorators.js';
import { TrackingService } from './tracking.service.js';

/** The customer's tracking page reads this with the token from its link. No account needed. */
@Controller('v1/tracking')
@Access('public')
export class TrackingController {
  constructor(private readonly tracking: TrackingService) {}

  @Get(':token')
  @Header('cache-control', 'no-store')
  @Header('referrer-policy', 'no-referrer')
  view(@Param('token') token: string): Promise<TrackingResponse> {
    return this.tracking.viewByToken(token.slice(0, 512));
  }
}
