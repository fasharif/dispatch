import type {
  DeliveryDto,
  DriverDto,
  DriverHomeDto,
  EnrolDeviceResult,
  LocationBatch,
  LocationBatchResult,
  ProofOfDeliveryInput,
} from '@dispatch/shared';
import { TransportError, type BatchTransport } from '../queue/replay';

const TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(
  apiUrl: string,
  path: string,
  init: {
    method?: string;
    token?: string;
    json?: unknown;
    form?: FormData;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${apiUrl.replace(/\/+$/, '')}${path}`, {
      method: init.method ?? (init.json !== undefined || init.form ? 'POST' : 'GET'),
      headers,
      body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
      signal: controller.signal,
    });
  } catch {
    throw new ApiError(null, 'No connection to the dispatch service');
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (!response.ok) {
    let message = `Request failed (${String(response.status)})`;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {
      // Keep the generic message.
    }
    throw new ApiError(response.status, message);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** The dispatch API as the driver app uses it. */
export class DriverApi implements BatchTransport {
  constructor(
    readonly apiUrl: string,
    private readonly token: string,
  ) {}

  static enrol(apiUrl: string, code: string, deviceName: string): Promise<EnrolDeviceResult> {
    return call(apiUrl, '/v1/devices/enrol', { json: { code, deviceName } });
  }

  me(): Promise<DriverHomeDto> {
    return call(this.apiUrl, '/v1/driver/me', { token: this.token });
  }

  setShift(onShift: boolean): Promise<DriverDto> {
    return call(this.apiUrl, '/v1/driver/shift', { token: this.token, json: { onShift } });
  }

  pickUp(deliveryId: string): Promise<DeliveryDto> {
    return call(this.apiUrl, `/v1/driver/deliveries/${deliveryId}/pickup`, {
      token: this.token,
      json: {},
    });
  }

  fail(deliveryId: string, reason: string): Promise<DeliveryDto> {
    return call(this.apiUrl, `/v1/driver/deliveries/${deliveryId}/fail`, {
      token: this.token,
      json: { reason },
    });
  }

  /**
   * Completes a delivery with its proof. The idempotency key makes a retry after a lost
   * response return the same result instead of an error.
   */
  complete(
    deliveryId: string,
    proof: ProofOfDeliveryInput,
    photo: { uri: string; mimeType: string },
    idempotencyKey: string,
  ): Promise<DeliveryDto> {
    const form = new FormData();
    form.append('proof', JSON.stringify(proof));
    // React Native's FormData sends a local file from its URI.
    form.append('photo', {
      uri: photo.uri,
      name: 'parcel.jpg',
      type: photo.mimeType,
    } as unknown as Blob);
    return call(this.apiUrl, `/v1/driver/deliveries/${deliveryId}/complete`, {
      token: this.token,
      form,
      headers: { 'idempotency-key': idempotencyKey },
    });
  }

  /** The queue's transport: maps HTTP failures to TransportError so replay can decide what to do. */
  async send(batch: LocationBatch): Promise<LocationBatchResult> {
    try {
      return await call<LocationBatchResult>(this.apiUrl, '/v1/driver/locations', {
        token: this.token,
        json: batch,
      });
    } catch (error) {
      if (error instanceof ApiError) throw new TransportError(error.status, error.message);
      throw error;
    }
  }
}
