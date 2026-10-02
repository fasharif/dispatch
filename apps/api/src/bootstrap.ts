import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Response } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import type { AppRequest } from './common/request-context.js';
import type { AppConfig } from './config/env.js';
import { RedisService } from './redis/redis.service.js';
import { RedisIoAdapter } from './realtime/redis-io.adapter.js';

/**
 * HTTP and WebSocket set-up shared by main.ts and the tests, so the tests exercise the same
 * middleware stack as production.
 */
export function configureApp(app: INestApplication, config: AppConfig): void {
  const express = app as NestExpressApplication;
  if (config.http.trustProxy) express.set('trust proxy', 1);
  express.disable('x-powered-by');
  express.useBodyParser('json', { limit: '512kb' });

  app.use((req: AppRequest, res: Response, next: NextFunction) => {
    const incoming = req.get('x-request-id');
    const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    req.requestId = id;
    res.setHeader('x-request-id', id);
    // Which instance answered: useful when watching the load balancer spread traffic.
    res.setHeader('x-served-by', config.instanceId);
    next();
  });
  app.use(helmet());
  app.enableCors({
    origin: config.http.corsOrigins,
    credentials: false,
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'x-served-by'],
  });
  app.useWebSocketAdapter(new RedisIoAdapter(app, app.get(RedisService), config));
  app.enableShutdownHooks();
}
