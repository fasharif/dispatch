import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import { InjectConfig } from '../config/config.module.js';
import type { AppConfig } from '../config/env.js';

/**
 * Owns every Redis connection the process opens, so they are all closed on shutdown.
 * `client` serves ordinary commands and the location stream; Socket.IO's adapter and BullMQ
 * open dedicated connections through `create`, because subscribers and blocking commands
 * cannot share a connection. Connections close in the last shutdown phase, after the HTTP and
 * WebSocket servers and the queues that use them have stopped.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private readonly connections: Redis[] = [];
  readonly client: Redis;

  constructor(@InjectConfig() private readonly config: AppConfig) {
    this.client = this.create('commands');
  }

  create(name: string, options: RedisOptions = {}): Redis {
    const connection = new Redis(this.config.redisUrl, {
      connectionName: `dispatch:${this.config.instanceId}:${name}`,
      ...options,
    });
    let lastLogged = 0;
    connection.on('error', (error: Error) => {
      // A reconnect loop would log every retry; once every 10 s is enough to notice.
      if (Date.now() - lastLogged > 10_000) {
        lastLogged = Date.now();
        this.logger.warn(`Redis connection "${name}": ${error.message}`);
      }
    });
    this.connections.push(connection);
    return connection;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      this.connections.map(async (connection) => {
        try {
          await connection.quit();
        } catch {
          connection.disconnect();
        }
      }),
    );
  }
}
