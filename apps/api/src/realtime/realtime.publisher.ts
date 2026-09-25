import { Injectable } from '@nestjs/common';
import type {
  DeliveryDto,
  DispatchServerToClientEvents,
  DriverLocationEvent,
  DriverStatusEvent,
  TrackingServerToClientEvents,
  TrackingView,
} from '@dispatch/shared';
import type { Namespace } from 'socket.io';

export const DISPATCHERS_ROOM = 'dispatchers';
export const trackingRoom = (deliveryId: string): string => `delivery:${deliveryId}`;

/**
 * Broadcasts to connected clients. The namespaces are registered by the gateways when the
 * Socket.IO server starts; with the Redis adapter a broadcast from any API instance reaches
 * the clients of every instance. In a worker-only process nothing is registered and
 * broadcasting is a no-op.
 */
@Injectable()
export class RealtimePublisher {
  private dispatch?: Namespace<Record<string, never>, DispatchServerToClientEvents>;
  private tracking?: Namespace<Record<string, never>, TrackingServerToClientEvents>;

  registerDispatch(
    namespace: Namespace<Record<string, never>, DispatchServerToClientEvents>,
  ): void {
    this.dispatch = namespace;
  }

  registerTracking(
    namespace: Namespace<Record<string, never>, TrackingServerToClientEvents>,
  ): void {
    this.tracking = namespace;
  }

  driverLocations(events: readonly DriverLocationEvent[]): void {
    const room = this.dispatch?.to(DISPATCHERS_ROOM);
    if (!room) return;
    for (const event of events) room.emit('driver:location', event);
  }

  driverStatus(event: DriverStatusEvent): void {
    this.dispatch?.to(DISPATCHERS_ROOM).emit('driver:status', event);
  }

  deliveryUpdated(delivery: DeliveryDto): void {
    this.dispatch?.to(DISPATCHERS_ROOM).emit('delivery:updated', delivery);
  }

  trackingUpdated(deliveryId: string, view: TrackingView): void {
    this.tracking?.to(trackingRoom(deliveryId)).emit('tracking:update', view);
  }
}
