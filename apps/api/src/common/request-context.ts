import type { Request } from 'express';

export interface DispatcherPrincipal {
  kind: 'dispatcher';
  id: string;
  email: string;
  name: string;
}

export interface DevicePrincipal {
  kind: 'device';
  deviceId: string;
  driverId: string;
  driverName: string;
}

export type Principal = DispatcherPrincipal | DevicePrincipal;

export interface AppRequest extends Request {
  requestId?: string;
  principal?: Principal;
}
