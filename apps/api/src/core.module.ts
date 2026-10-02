import { Global, Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { Database } from './db/database.js';
import { RedisService } from './redis/redis.service.js';

/** Configuration, the database pool and Redis connections: shared by the API and the worker. */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [Database, RedisService],
  exports: [Database, RedisService],
})
export class CoreModule {}
