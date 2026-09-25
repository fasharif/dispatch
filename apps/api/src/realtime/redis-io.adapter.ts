import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server, ServerOptions } from 'socket.io';
import type { AppConfig } from '../config/env.js';
import type { RedisService } from '../redis/redis.service.js';

/**
 * Socket.IO over WebSocket only, fanned out across API instances by the Redis adapter:
 * an emit on one instance is published on Redis and delivered by every instance to its own
 * connected clients. Long-polling is disabled, so no sticky sessions are needed at the load
 * balancer.
 */
export class RedisIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly redis: RedisService,
    private readonly config: AppConfig,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const allowed = new Set(this.config.http.corsOrigins);
    const merged: Partial<ServerOptions> = {
      ...options,
      transports: ['websocket'],
      serveClient: false,
      pingInterval: 10_000,
      pingTimeout: 5_000,
      maxHttpBufferSize: 64 * 1024,
      cors: { origin: [...allowed], credentials: false },
      // Browsers send Origin on WebSocket upgrades; native apps and servers do not.
      allowRequest: (request, callback) => {
        const origin = request.headers.origin;
        callback(null, !origin || allowed.has(origin));
      },
    };
    // Nest passes partial options too; socket.io fills in the defaults for anything left out.
    const server = super.createIOServer(port, merged as ServerOptions);
    server.adapter(
      createAdapter(this.redis.create('socket.io-pub'), this.redis.create('socket.io-sub'), {
        key: 'dispatch:socket.io',
      }),
    );
    return server;
  }
}
