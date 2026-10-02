import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Access } from '../auth/auth.decorators.js';
import { InjectConfig } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';
import { Database } from '../db/database.js';
import { RedisService } from '../redis/redis.service.js';

interface Health {
  status: 'ok' | 'degraded';
  instance: string;
  uptimeSeconds: number;
  database?: 'up' | 'down';
  redis?: 'up' | 'down';
}

@Controller('health')
@Access('public')
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly db: Database,
    private readonly redis: RedisService,
    @InjectConfig() private readonly config: AppConfig,
  ) {}

  /** Liveness: the process answers. Touches no dependency. */
  @Get()
  live(): Health {
    return {
      status: 'ok',
      instance: this.config.instanceId,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  /** Readiness: PostgreSQL and Redis answer. 503 tells the load balancer to stop routing here. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<Health> {
    const [database, redis] = await Promise.all([
      this.db.query('SELECT 1').then(
        () => 'up' as const,
        () => 'down' as const,
      ),
      this.redis.client.ping().then(
        () => 'up' as const,
        () => 'down' as const,
      ),
    ]);
    const ok = database === 'up' && redis === 'up';
    if (!ok) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: ok ? 'ok' : 'degraded',
      instance: this.config.instanceId,
      uptimeSeconds: Math.round(process.uptime()),
      database,
      redis,
    };
  }
}
