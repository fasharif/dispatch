import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MulterModule } from '@nestjs/platform-express';
import { ThrottlerModule } from '@nestjs/throttler';
import { AccessGuard } from './auth/access.guard.js';
import { AuthFailures } from './auth/auth-failures.js';
import { DeviceTokens } from './auth/device-tokens.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { AccessTokens } from './auth/tokens.js';
import { HttpExceptionFilter } from './common/http-exception.filter.js';
import { CallerThrottlerGuard, RedisThrottlerStorage } from './common/throttle.js';
import { APP_CONFIG } from './config/config.module.js';
import type { AppConfig } from './config/env.js';
import { CoreModule } from './core.module.js';
import {
  DeliveriesController,
  DriverDeliveriesController,
} from './deliveries/deliveries.controller.js';
import { DeliveriesService } from './deliveries/deliveries.service.js';
import {
  DevicesController,
  DriverAppController,
  DriversController,
} from './drivers/drivers.controller.js';
import { DriversService } from './drivers/drivers.service.js';
import { EtaService } from './eta/eta.service.js';
import { HealthController } from './health/health.controller.js';
import { LocationsService } from './locations/locations.service.js';
import { OutboxQueue } from './outbox/outbox.queue.js';
import { OutboxRepository } from './outbox/outbox.repository.js';
import { WebhooksController } from './outbox/webhooks.controller.js';
import { PhotoStorage } from './proof/photo-storage.js';
import { ProofService } from './proof/proof.service.js';
import { DispatchGateway, TrackingGateway } from './realtime/gateways.js';
import { LocationStream } from './realtime/location-stream.js';
import { RealtimePublisher } from './realtime/realtime.publisher.js';
import { RedisService } from './redis/redis.service.js';
import { TrackingController } from './tracking/tracking.controller.js';
import { TrackingTokens } from './tracking/tracking-tokens.js';
import { TrackingService } from './tracking/tracking.service.js';

/** The HTTP and WebSocket process. Background jobs run in WorkerModule. */
@Module({
  imports: [
    CoreModule,
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG, RedisService],
      useFactory: (config: AppConfig, redis: RedisService) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: config.http.throttleLimit }],
        storage: new RedisThrottlerStorage(redis.client),
      }),
    }),
    // Proof-of-delivery uploads: multer stops reading at MAX_PHOTO_BYTES, so an oversized upload
    // is refused with 413 before it is buffered in full.
    MulterModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        limits: { fileSize: config.uploads.maxPhotoBytes, files: 1, fields: 4 },
      }),
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    DriversController,
    DevicesController,
    DriverAppController,
    DeliveriesController,
    DriverDeliveriesController,
    TrackingController,
    WebhooksController,
  ],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    // Guards run in this order: identify the caller, then rate-limit per caller. Failed
    // device-token checks are limited per address inside AccessGuard, before the lookup.
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_GUARD, useClass: CallerThrottlerGuard },
    AccessTokens,
    AuthFailures,
    DeviceTokens,
    AuthService,
    DriversService,
    LocationsService,
    DeliveriesService,
    ProofService,
    PhotoStorage,
    TrackingTokens,
    TrackingService,
    EtaService,
    LocationStream,
    RealtimePublisher,
    OutboxRepository,
    OutboxQueue,
    DispatchGateway,
    TrackingGateway,
  ],
})
export class AppModule {}
