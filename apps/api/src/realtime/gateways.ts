import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayInit,
} from '@nestjs/websockets';
import {
  DISPATCH_NAMESPACE,
  TRACKING_NAMESPACE,
  type DispatchServerToClientEvents,
  type ResumeResponse,
  type TrackingServerToClientEvents,
} from '@dispatch/shared';
import type { Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import { AccessTokens } from '../auth/tokens.js';
import { TrackingService } from '../tracking/tracking.service.js';
import { LocationStream } from './location-stream.js';
import { DISPATCHERS_ROOM, RealtimePublisher, trackingRoom } from './realtime.publisher.js';

const resumeSchema = z.object({
  since: z.string().max(40).nullable(),
  limit: z.int().min(1).max(2_000).optional(),
});

function handshakeToken(socket: Socket): string | null {
  const auth = socket.handshake.auth as { token?: unknown } | undefined;
  return typeof auth?.token === 'string' && auth.token.length <= 4096 ? auth.token : null;
}

/**
 * Dispatcher consoles. A connection must present a dispatcher access token in the handshake
 * (`auth: { token }`); it then joins the dispatchers room and receives every driver position,
 * driver status change and delivery update.
 */
@WebSocketGateway({ namespace: DISPATCH_NAMESPACE })
export class DispatchGateway implements OnGatewayInit {
  private readonly logger = new Logger(DispatchGateway.name);

  constructor(
    private readonly tokens: AccessTokens,
    private readonly stream: LocationStream,
    private readonly publisher: RealtimePublisher,
  ) {}

  afterInit(namespace: Namespace<Record<string, never>, DispatchServerToClientEvents>): void {
    this.publisher.registerDispatch(namespace);
    namespace.use((socket, next) => {
      const token = handshakeToken(socket);
      if (!token) {
        next(new Error('unauthorized'));
        return;
      }
      this.tokens.verify(token).then(
        (dispatcher) => {
          socket.data = { dispatcherId: dispatcher.id };
          void socket.join(DISPATCHERS_ROOM);
          next();
        },
        () => {
          next(new Error('unauthorized'));
        },
      );
    });
  }

  /**
   * After a reconnect the console sends the newest stream id it saw and receives what it
   * missed, page by page (see LiveFeed in @dispatch/shared).
   */
  @SubscribeMessage('resume')
  async resume(
    @MessageBody() body: unknown,
    @ConnectedSocket() socket: Socket,
  ): Promise<ResumeResponse> {
    const request = resumeSchema.safeParse(body);
    if (!request.success) return { events: [], complete: true, gap: true };
    try {
      return await this.stream.readAfter(request.data.since, request.data.limit);
    } catch (error) {
      this.logger.warn(`Resume failed for ${socket.id}: ${(error as Error).message}`);
      return { events: [], complete: true, gap: true };
    }
  }
}

/**
 * Customers following a tracking link. The handshake carries the link's token; the socket joins
 * the room of that delivery only, receives its current state at once and is disconnected when
 * the link expires.
 */
@WebSocketGateway({ namespace: TRACKING_NAMESPACE })
export class TrackingGateway implements OnGatewayInit, OnGatewayConnection {
  constructor(
    private readonly tracking: TrackingService,
    private readonly publisher: RealtimePublisher,
  ) {}

  afterInit(namespace: Namespace<Record<string, never>, TrackingServerToClientEvents>): void {
    this.publisher.registerTracking(namespace);
    namespace.use((socket, next) => {
      const token = handshakeToken(socket);
      try {
        if (!token) throw new Error('missing token');
        const { deliveryId, expiresAt } = this.tracking.resolve(token);
        socket.data = { deliveryId, expiresAt: expiresAt.getTime() };
        next();
      } catch {
        next(new Error('invalid or expired tracking link'));
      }
    });
  }

  async handleConnection(
    socket: Socket<Record<string, never>, TrackingServerToClientEvents>,
  ): Promise<void> {
    const { deliveryId, expiresAt } = socket.data as { deliveryId: string; expiresAt: number };
    await socket.join(trackingRoom(deliveryId));
    const timer = setTimeout(() => socket.disconnect(true), Math.max(0, expiresAt - Date.now()));
    timer.unref();
    socket.once('disconnect', () => {
      clearTimeout(timer);
    });
    const view = await this.tracking.view(deliveryId);
    if (view) socket.emit('tracking:update', view);
  }
}
